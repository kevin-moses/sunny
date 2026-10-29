// digest.ts
// Purpose: Compose and send a household's daily digest (queueing: lib/digest.ts; facts:
// lib/digestFacts.ts; words: lib/digestText.ts). The workpool runs `compose` for a digests
// row: `load` reads the day's facts and the number of verified recipients (a query, so a
// retry re-reads current data); the action asks Claude Haiku for the text under a strict
// prompt and validates the reply (1-5 plain lines, under 600 characters, no markup), and uses
// the deterministic template on any failure, invalid output, missing key, a quiet day, or when
// nobody can receive it; `complete` then, in one transaction, stores the text and the path
// that produced it ("claude" or "template"), re-reads the household's members, and inserts one
// "digest" outbox row per member with a verified phone through the same delivery path
// (lib/delivery.ts insertNotification), so delivery retries and the sweeper apply. `complete`
// is a no-op unless the row is still pending, so a duplicate job (sweeper) sends nothing twice.
// A run that fails for good (onComposeComplete) marks the row failed.
//
// Last modified: 2026-10-29

import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { insertNotification } from "./lib/delivery";
import { gatherDigestFacts } from "./lib/digestFacts";
import { composeWithClaude } from "./lib/digestModel";
import { factsForPrompt, isQuietDay, templateDigest, validateDigestReply } from "./lib/digestText";
import { digestSource } from "./lib/validators";
import type { DigestSource } from "./lib/validators";

/** What `load` returns: the rendered inputs for composing, or null when there is no work. */
export interface DigestInput {
  quiet: boolean;
  recipients: number;
  template: string;
  factsMessage: string;
}

/**
 * purpose: Members of a household who can receive an SMS: a phone and a verification time.
 * @param members: (Doc<"householdMembers">[]) The household's members.
 * @return: (Doc<"householdMembers">[]) Those reachable by SMS.
 */
function smsReachable(members: Doc<"householdMembers">[]): Doc<"householdMembers">[] {
  return members.filter((m) => m.phone !== undefined && m.phoneVerifiedAt !== undefined);
}

/**
 * purpose: Read what composing a digest needs: the day's facts rendered as the template text
 *          and the prompt message, whether it was a quiet day, and how many members have a
 *          verified phone. Null when the digest is gone or no longer pending.
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
    const members = await ctx.db
      .query("householdMembers")
      .withIndex("by_household_user", (q) => q.eq("householdId", household._id))
      .collect();
    return {
      quiet: isQuietDay(facts),
      recipients: smsReachable(members).length,
      template: templateDigest(facts),
      factsMessage: factsForPrompt(facts),
    };
  },
});

/**
 * purpose: Store the digest text and queue one SMS outbox row per member with a verified
 *          phone. Does nothing unless the digest is still pending.
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
    const recipients = smsReachable(members);
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
    await ctx.db.patch(digestId, {
      status: recipients.length > 0 ? "sent" : "no_recipients",
      source,
      text,
      recipients: recipients.length,
    });
    return recipients.length;
  },
});

/**
 * purpose: Choose the digest text: the template for a quiet day or when nobody can receive
 *          it; otherwise the model's validated reply, falling back to the template on an
 *          API error, a missing key or invalid output.
 * @param input: (DigestInput) The loaded inputs.
 * @return: (Promise<{ text: string; source: DigestSource }>) The text and the path used.
 */
async function chooseText(input: DigestInput): Promise<{ text: string; source: DigestSource }> {
  const fallback = { text: input.template, source: "template" as const };
  if (input.quiet || input.recipients === 0) return fallback;
  try {
    const reply = validateDigestReply(await composeWithClaude(input.factsMessage));
    if (reply === null) {
      console.error("Digest: the model reply was invalid; using the template");
      return fallback;
    }
    return { text: reply, source: "claude" };
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
