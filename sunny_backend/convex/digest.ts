import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { householdCaregivers } from "./lib/access";
import { postDigest } from "./lib/chatPosts";
import {
  deliveryPool,
  insertNotification,
  reachableMembers,
  STUCK_AFTER_MS,
  SWEEP_BATCH,
} from "./lib/delivery";
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

export interface DigestInput {
  quiet: boolean;
  template: string;
  fixed: string[];
  factsMessage: string;
  maxLines: number;
  maxChars: number;
  hasMore: boolean;
}

async function enqueueDigest(ctx: MutationCtx, digestId: Id<"digests">): Promise<void> {
  await deliveryPool.enqueueAction(
    ctx,
    internal.digest.compose,
    { digestId },
    { onComplete: internal.digest.onComposeComplete, context: { digestId } },
  );
}

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

export const complete = internalMutation({
  args: { digestId: v.id("digests"), text: v.string(), source: digestSource },
  handler: async (ctx, { digestId, text, source }): Promise<number> => {
    const digest = await ctx.db.get(digestId);
    if (!digest || digest.status !== "pending") return 0;
    const household = await ctx.db.get(digest.householdId);
    if (!household) return 0;
    await postDigest(ctx, digest, text);
    const members = await householdCaregivers(ctx, household._id);
    const recipients = await reachableMembers(ctx, members);
    for (const member of recipients) {
      await insertNotification(ctx, {
        householdId: household._id,
        kind: "digest",
        recipientUserId: member.userId,
        title: `Sunny: ${household.seniorPreferredName}'s day`,
        body: text,
        payload: {
          digestId,
          localDate: digest.localDate,
          pushTitle: `${household.seniorPreferredName}'s day`,
        },
      });
    }
    await ctx.db.patch(digestId, { status: "done", source, text });
    return recipients.length;
  },
});

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
