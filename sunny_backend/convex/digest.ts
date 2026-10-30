// digest.ts
// Purpose: The household's daily digest. queueDigestIfDue (called by the scheduler tick) records
// a digests row once local time reaches digestTime, unique per household and local date, and
// enqueues `compose` on the delivery workpool. `compose` writes the not-done and alert lines
// from the template, asks Claude Haiku for the rest (lib/digestText.ts), and falls back to the
// whole template on any failure, invalid reply or quiet day; `complete` then stores the text and
// the path that wrote it and inserts one "digest" outbox row per member with a verified phone. Rules: a paused household gets no
// digest until resumed; a household created after that day's digest time gets none that day.
//
// Last modified: 2026-10-29

import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { verifiedPhone } from "./lib/access";
import { deliveryPool, insertNotification, STUCK_AFTER_MS, SWEEP_BATCH } from "./lib/delivery";
import { gatherDigestFacts } from "./lib/digestFacts";
import {
  composeWithClaude,
  factsForPrompt,
  fixedLines,
  isQuietDay,
  modelBudget,
  templateDigest,
  validateDigestReply,
} from "./lib/digestText";
import { localDate, localTime, zonedInstant } from "./lib/time";
import { digestSource } from "./lib/validators";
import type { DigestSource } from "./lib/validators";

/** What `load` returns: the day's facts rendered for composing. */
export interface DigestInput {
  /** Nothing at all was logged. */
  quiet: boolean;
  /** The whole digest as the template writes it. */
  template: string;
  /** The lines the model never writes (not done, alerts). */
  fixed: string[];
  /** The facts the model may write about. */
  factsMessage: string;
  /** Lines and characters left for the model, and whether it has anything to write about. */
  maxLines: number;
  maxChars: number;
  hasMore: boolean;
}

/**
 * purpose: Enqueue the compose action for a digests row.
 * @param ctx: (MutationCtx) Context.
 * @param digestId: (Id<"digests">) The row.
 * @return: (Promise<void>) Resolves when enqueued.
 */
async function enqueueDigest(ctx: MutationCtx, digestId: Id<"digests">): Promise<void> {
  await deliveryPool.enqueueAction(
    ctx,
    internal.digest.compose,
    { digestId },
    { onComplete: internal.digest.onComposeComplete, context: { digestId } },
  );
}

/**
 * purpose: Record and enqueue the household's digest for its local today when it is due. The
 *          household's lastDigestDate lets ticks after the digest skip the digests lookup. A
 *          digestTime inside a skipped DST hour still fires, since the comparison is "at or
 *          after" on local wall-clock time.
 * @param ctx: (MutationCtx) Mutation context.
 * @param household: (Doc<"households">) The household as the tick read it.
 * @param now: (number) Epoch ms.
 * @return: (Promise<boolean>) True when a digest was queued by this call.
 */
export async function queueDigestIfDue(
  ctx: MutationCtx,
  household: Doc<"households">,
  now: number,
): Promise<boolean> {
  if (household.backgroundPaused) return false;
  if (localTime(now, household.timezone) < household.digestTime) return false;
  const date = localDate(now, household.timezone);
  if (household.lastDigestDate === date) return false;
  if (household._creationTime > zonedInstant(date, household.digestTime, household.timezone)) {
    return false;
  }
  const existing = await ctx.db
    .query("digests")
    .withIndex("by_household_date", (q) => q.eq("householdId", household._id).eq("localDate", date))
    .first();
  if (existing) return false;
  const digestId = await ctx.db.insert("digests", {
    householdId: household._id,
    localDate: date,
    status: "pending",
  });
  await ctx.db.patch(household._id, { lastDigestDate: date });
  await enqueueDigest(ctx, digestId);
  return true;
}

/**
 * purpose: Enqueue again the digests left pending for STUCK_AFTER_MS (the job was lost).
 * @param ctx: (MutationCtx) Context.
 * @param now: (number) Epoch ms.
 * @return: (Promise<number>) Digests re-enqueued (at most SWEEP_BATCH per run).
 */
export async function requeueStuckDigests(ctx: MutationCtx, now: number): Promise<number> {
  const stuck = await ctx.db
    .query("digests")
    .withIndex("by_status", (q) =>
      q.eq("status", "pending").lt("_creationTime", now - STUCK_AFTER_MS),
    )
    .take(SWEEP_BATCH);
  for (const digest of stuck) await enqueueDigest(ctx, digest._id);
  return stuck.length;
}

/**
 * purpose: Read what composing a digest needs: the day's facts rendered as the template text
 *          and the prompt message, and whether it was a quiet day. Null when the digest is
 *          gone or no longer pending.
 * @param digestId: (Id<"digests">) The digest.
 * @return: (DigestInput | null) The inputs.
 */
export const load = internalQuery({
  args: { digestId: v.id("digests") },
  handler: async (ctx, { digestId }): Promise<DigestInput | null> => {
    const digest = await ctx.db.get(digestId);
    if (!digest || digest.status !== "pending") return null;
    const household = await ctx.db.get(digest.householdId);
    if (!household) return null;
    const facts = await gatherDigestFacts(ctx, household, digest.localDate);
    return {
      quiet: isQuietDay(facts),
      template: templateDigest(facts),
      fixed: fixedLines(facts),
      factsMessage: factsForPrompt(facts),
      ...modelBudget(facts),
    };
  },
});

/**
 * purpose: Store the digest text and queue one SMS outbox row per member with a verified
 *          phone (read now, so a number verified or removed since loading is honored). Does
 *          nothing unless the digest is still pending.
 * @param digestId: (Id<"digests">) The digest.
 * @param text: (string) The digest text.
 * @param source: ("claude" | "template") Which path produced it.
 * @return: (number) Outbox rows queued.
 */
export const complete = internalMutation({
  args: { digestId: v.id("digests"), text: v.string(), source: digestSource },
  handler: async (ctx, { digestId, text, source }): Promise<number> => {
    const digest = await ctx.db.get(digestId);
    if (!digest || digest.status !== "pending") return 0;
    const household = await ctx.db.get(digest.householdId);
    if (!household) return 0;
    const members = await ctx.db
      .query("householdMembers")
      .withIndex("by_household_user", (q) => q.eq("householdId", household._id))
      .collect();
    const recipients = members.filter((m) => verifiedPhone(m) !== undefined);
    for (const member of recipients) {
      await insertNotification(ctx, {
        householdId: household._id,
        kind: "digest",
        recipientUserId: member.userId,
        title: `Sunny: ${household.seniorPreferredName}'s day`,
        body: text,
        payload: { digestId, localDate: digest.localDate },
      });
    }
    await ctx.db.patch(digestId, { status: "done", source, text });
    return recipients.length;
  },
});

/**
 * purpose: Choose the digest text. A quiet day, or a day with nothing for the model to write
 *          about, uses the template. Otherwise the fixed lines (not done, alerts) come first
 *          and the model's validated reply follows; any API or configuration error or invalid
 *          reply falls back to the whole template.
 * @param input: (DigestInput) The loaded inputs.
 * @return: (Promise<{ text: string; source: DigestSource }>) The text and the path used.
 */
async function chooseText(input: DigestInput): Promise<{ text: string; source: DigestSource }> {
  const fallback = { text: input.template, source: "template" as const };
  if (input.quiet || !input.hasMore) return fallback;
  try {
    const limits = `Write at most ${input.maxLines} lines and ${input.maxChars} characters in total.`;
    const reply = validateDigestReply(
      await composeWithClaude(`${input.factsMessage}\n\n${limits}`),
      input.factsMessage,
      input,
    );
    if (reply === null) {
      console.error("Digest: the model reply was invalid; using the template");
      return fallback;
    }
    return { text: [...input.fixed, reply].join("\n"), source: "claude" };
  } catch (e) {
    console.error(`Digest: the model call failed; using the template (${String(e)})`);
    return fallback;
  }
}

/**
 * purpose: The workpool action: compose the digest and queue its messages.
 * @param digestId: (Id<"digests">) The digest.
 * @return: ("skipped" | "claude" | "template") "skipped" when there was nothing pending,
 *          otherwise the path that produced the text.
 */
export const compose = internalAction({
  args: { digestId: v.id("digests") },
  handler: async (ctx, { digestId }): Promise<"skipped" | DigestSource> => {
    const input: DigestInput | null = await ctx.runQuery(internal.digest.load, { digestId });
    if (input === null) return "skipped";
    const { text, source } = await chooseText(input);
    await ctx.runMutation(internal.digest.complete, { digestId, text, source });
    return source;
  },
});

/**
 * purpose: Workpool completion handler: a compose run that failed for good marks a still
 *          pending digest failed with the error (internal detail).
 * @param workId: (string) The workpool work id.
 * @param context: ({ digestId }) The digest.
 * @param result: (RunResult) success, failed, or canceled.
 * @return: (null)
 */
export const onComposeComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ digestId: v.id("digests") })),
  handler: async (ctx, { context, result }): Promise<null> => {
    if (result.kind !== "failed") return null;
    const digest = await ctx.db.get(context.digestId);
    if (!digest || digest.status !== "pending") return null;
    console.error(`Digest compose failed: ${result.error}`);
    await ctx.db.patch(digest._id, { status: "failed", error: result.error });
    return null;
  },
});
