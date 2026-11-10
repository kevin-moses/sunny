// convex/agent.ts
// Purpose: The API the Python voice agent calls over Convex's HTTP API (POST /api/query and
// /api/mutation). Every function takes `agentKey` first and compares it in constant time with
// the SUNNY_AGENT_KEY deployment env var (a missing env var or a mismatch is forbidden);
// agentQuery and agentMutation wrap that check once. The actor is the voice agent
// ({ kind: "agent" }, no caregiver behind it), so the instance cores treat it as the backend.
// This module is only the agent:* surface (argument validation, the household and
// conversation checks, the clock); each concern lives in a lib module:
// - context: lib/agentContext.ts (getContext, and the message readLatestMessage reads aloud);
// - tasks: instances.ts confirmDueTaskCore (voice confirm, never with a press age) and the
//   reminder cores; lib/voiceTasks.ts ("not yet", medication facts);
// - as-needed doses: lib/voiceDoses.ts and lib/doseLimits.ts;
// - flags and family messages: lib/voiceRouting.ts (reachable caregivers only, caps);
// - memory: lib/seniorMemory.ts (rememberFact), with the reads and limits profile.ts uses;
// - the household list: lib/householdList.ts;
// - the conversation record and question log: lib/conversationLog.ts.
//
// Trust model: these functions trust the householdId the agent passes. It comes from the
// LiveKit participant metadata written by voice.livekitToken, never from the model, so the
// agent key is the only gate. Anyone holding the key can act for any household. A
// conversationId passed together with a householdId must belong to that household.
//
// Clock: an optional `now` (epoch ms) is honored here only (backend callers), else Date.now().
// Instants in results are epoch ms; absent optional values are null.
//
// Last modified: 2026-11-09

import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import type { Validator } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import {
  cancelSeniorReminderCore,
  confirmDueTaskCore,
  createSeniorReminderCore,
} from "./instances";
import type { CancelReminderResult, ConfirmDueResult } from "./instances";
import { loadHousehold } from "./lib/access";
import { buildAgentContext, latestCaregiverMessage } from "./lib/agentContext";
import type { AgentContext, MessageView } from "./lib/agentContext";
import {
  finishConversationCore,
  householdConversation,
  logQuestionsCore,
  logTurnCore,
  startConversationCore,
} from "./lib/conversationLog";
import { appError } from "./lib/errors";
import { addSpokenItemsCore, openListItems, tickItemByWordsCore } from "./lib/householdList";
import type { AddedItem, TickItemResult } from "./lib/householdList";
import { constantTimeEqual } from "./lib/secretBox";
import { searchWords } from "./lib/text";
import { rememberFactCore } from "./lib/seniorMemory";
import { todayInstances } from "./lib/today";
import type { TodayEntry } from "./lib/today";
import { questionOutcome } from "./lib/validators";
import { logAsNeededDoseCore, undoLastDoseCore } from "./lib/voiceDoses";
import type { LogDoseResult, UndoDoseResult } from "./lib/voiceDoses";
import {
  VOICE_AGENT,
  flagCaregiverCore,
  modelFlagReason,
  sendFamilyMessageCore,
} from "./lib/voiceRouting";
import type { FamilyMessageResult, FlagResult } from "./lib/voiceRouting";
import { dueScheduledMedication, medicationStatusCore, snoozeDueTaskCore } from "./lib/voiceTasks";
import type { MedicationStatus, SnoozeResult } from "./lib/voiceTasks";

export { MAX_TURN_CONTENT_LENGTH } from "./lib/conversationLog";

/**
 * purpose: An optional argument the Python client may send as null.
 * @param validator: (Validator) The value's validator.
 * @return: (Validator) Optional value-or-null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nullable<T extends Validator<any, "required", any>>(validator: T) {
  return v.optional(v.union(validator, v.null()));
}

/**
 * purpose: Reject a call whose agent key is not the deployment's SUNNY_AGENT_KEY.
 * @param agentKey: (string) Key supplied by the caller.
 * @return: (void)
 * @raises forbidden when the env var is missing or empty, or the key does not match.
 */
export function requireAgentKey(agentKey: string): void {
  const expected = process.env.SUNNY_AGENT_KEY;
  if (!expected || !constantTimeEqual(agentKey, expected)) {
    throw appError("forbidden", "Invalid agent key");
  }
}

/**
 * purpose: Query builder that requires a valid `agentKey` argument and strips it from the
 *          handler args.
 * @param args: (object) Function definition: `args` validators and `handler`.
 * @return: (RegisteredQuery) The registered query.
 * @raises forbidden when the agent key is wrong.
 */
const agentQuery = customQuery(query, {
  args: { agentKey: v.string() },
  input: async (_ctx, { agentKey }) => {
    requireAgentKey(agentKey);
    return { ctx: {}, args: {} };
  },
});

/**
 * purpose: Mutation builder that requires a valid `agentKey` argument and strips it from the
 *          handler args.
 * @param args: (object) Function definition: `args` validators and `handler`.
 * @return: (RegisteredMutation) The registered mutation.
 * @raises forbidden when the agent key is wrong.
 */
const agentMutation = customMutation(mutation, {
  args: { agentKey: v.string() },
  input: async (_ctx, { agentKey }) => {
    requireAgentKey(agentKey);
    return { ctx: {}, args: {} };
  },
});

/**
 * purpose: The clock for an agent call: the caller's `now` when given, else the server clock.
 * @param now: (number | undefined) Optional epoch ms from the caller.
 * @return: (number) Epoch ms.
 */
function clock(now: number | undefined): number {
  return now ?? Date.now();
}

/**
 * purpose: Everything the agent knows about a household at the start of a conversation
 *          (lib/agentContext.buildAgentContext).
 * @param householdId: (Id<"households">) Household, from the participant metadata.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (AgentContext) The context.
 * @raises not_found when the household does not exist.
 */
export const getContext = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<AgentContext> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await buildAgentContext(ctx, household, clock(args.now));
  },
});

/**
 * purpose: Today's schedule for a household.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (TodayEntry[]) Today's entries (see lib/today).
 * @raises not_found when the household does not exist.
 */
export const today = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<TodayEntry[]> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await todayInstances(ctx, household._id, clock(args.now));
  },
});

/**
 * purpose: The facts for a medication question, read fresh: today's scheduled medications and
 *          each as-needed medication's label facts (lib/voiceTasks.medicationStatusCore).
 * @param householdId: (Id<"households">) Household.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (MedicationStatus) Scheduled and as-needed facts.
 * @raises not_found when the household does not exist.
 */
export const medicationStatus = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MedicationStatus> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await medicationStatusCore(ctx, household, clock(args.now));
  },
});

/**
 * purpose: Confirm the task the senior means, by voice ("I took my pills"), through the same
 *          core as the Done button (instances.confirmDueTaskCore). A voice confirm is live, so
 *          it never carries a press age.
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null, optional) Words from the task's display label.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (ConfirmDueResult) Same shape as instances.confirmDueTask.
 */
export const confirmDueTask = agentMutation({
  args: {
    householdId: v.id("households"),
    label: nullable(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ConfirmDueResult> => {
    return await confirmDueTaskCore(
      ctx,
      VOICE_AGENT,
      { householdId: args.householdId, via: "voice", label: args.label ?? undefined },
      clock(args.now),
    );
  },
});

/**
 * purpose: "Not yet": snooze the due task's prompts 15 minutes (lib/voiceTasks).
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null, optional) Words from the task's display label.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (SnoozeResult) The outcome and the task it was about.
 * @raises not_found when the household does not exist.
 */
export const snoozeDueTask = agentMutation({
  args: {
    householdId: v.id("households"),
    label: nullable(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SnoozeResult> => {
    await loadHousehold(ctx, args.householdId);
    return await snoozeDueTaskCore(ctx, args.householdId, args.label, clock(args.now));
  },
});

/**
 * purpose: Log an as-needed dose the senior says they took (lib/voiceDoses): label facts
 *          afterwards, the caregiver flagged past a limit or on repeated use; nothing logged
 *          without a matching rule, when a due scheduled medication better explains an unnamed
 *          "I took my pills", or when the same dose (within 30 minutes) is already logged.
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null, optional) Words naming the medication.
 * @param minutesAgo: (number | null, optional) Whole minutes since the dose, 0..720; default 0.
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (LogDoseResult) logged, already_logged, or no_rule / not_found / ambiguous /
 *          scheduled_due with the labels to choose from.
 * @raises invalid for a bad minutesAgo; not_found for a conversation of another household.
 */
export const logAsNeededDose = agentMutation({
  args: {
    householdId: v.id("households"),
    label: nullable(v.string()),
    minutesAgo: nullable(v.number()),
    conversationId: nullable(v.id("conversations")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LogDoseResult> => {
    const now = clock(args.now);
    const household = await loadHousehold(ctx, args.householdId);
    return await logAsNeededDoseCore(ctx, {
      household,
      words: searchWords(args.label),
      minutesAgo: args.minutesAgo ?? 0,
      dueScheduled: () => dueScheduledMedication(ctx, household._id, now),
      conversationId: await householdConversation(ctx, household._id, args.conversationId),
      now,
    });
  },
});

/**
 * purpose: "No, I didn't take it": remove today's latest voice-reported as-needed dose
 *          (lib/voiceDoses), audited; a flag already sent stays sent.
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null, optional) Words naming the medication.
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (UndoDoseResult) removed, or nothing_to_undo / no_rule / not_found / ambiguous.
 * @raises not_found for a conversation of another household.
 */
export const undoLastDose = agentMutation({
  args: {
    householdId: v.id("households"),
    label: nullable(v.string()),
    conversationId: nullable(v.id("conversations")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<UndoDoseResult> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await undoLastDoseCore(ctx, {
      household,
      words: searchWords(args.label),
      conversationId: await householdConversation(ctx, household._id, args.conversationId),
      now: clock(args.now),
    });
  },
});

/**
 * purpose: Create a reminder the senior asked for (instances.createSeniorReminderCore).
 * @param householdId: (Id<"households">) Household.
 * @param title: (string) What to be reminded of.
 * @param time: (string) Local "HH:MM".
 * @param onDate: (string | null, optional) One-off local date, today or later.
 * @param days: (number[] | null, optional) ISO weekdays for a recurring reminder.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: ({taskId}) The new task's id.
 */
export const createSeniorReminder = agentMutation({
  args: {
    householdId: v.id("households"),
    title: v.string(),
    time: v.string(),
    onDate: nullable(v.string()),
    days: nullable(v.array(v.number())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ taskId: Id<"tasks"> }> => {
    const task = await createSeniorReminderCore(
      ctx,
      VOICE_AGENT,
      {
        householdId: args.householdId,
        title: args.title,
        time: args.time,
        onDate: args.onDate ?? undefined,
        days: args.days ?? undefined,
      },
      clock(args.now),
    );
    return { taskId: task._id };
  },
});

/**
 * purpose: Cancel a reminder the senior created, matched by title words.
 * @param householdId: (Id<"households">) Household.
 * @param query: (string) Words in the reminder's title.
 * @return: (CancelReminderResult) cancelled | not_found | ambiguous, with titles.
 */
export const cancelSeniorReminder = agentMutation({
  args: { householdId: v.id("households"), query: v.string() },
  handler: async (ctx, args): Promise<CancelReminderResult> => {
    return await cancelSeniorReminderCore(ctx, VOICE_AGENT, args, Date.now());
  },
});

/**
 * purpose: Remember something the senior said, unverified (lib/seniorMemory): never edits or
 *          verifies an existing fact, skips a duplicate, trims the oldest unverified senior
 *          facts beyond 200.
 * @param householdId: (Id<"households">) Household.
 * @param fact: (string) The fact; blank is rejected.
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @return: ({status}) saved, or already_known (both success).
 * @raises invalid for a blank fact; not_found for a conversation of another household.
 */
export const rememberFact = agentMutation({
  args: {
    householdId: v.id("households"),
    fact: v.string(),
    conversationId: nullable(v.id("conversations")),
  },
  handler: async (ctx, args): Promise<{ status: "saved" | "already_known" }> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await rememberFactCore(ctx, {
      householdId: household._id,
      fact: args.fact,
      conversationId: await householdConversation(ctx, household._id, args.conversationId),
    });
  },
});

/**
 * purpose: Ask the on-call caregiver (or every reachable caregiver) to look in
 *          (lib/voiceRouting.flagCaregiverCore). medication_limit is not accepted here:
 *          log_dose raises it, keyed on the medication.
 * @param householdId: (Id<"households">) Household.
 * @param reason: (string) symptom, money_request, scam, distress or help_requested.
 * @param detail: (string) A short description for the caregiver (two sentences reach them).
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (FlagResult) flagged, already_flagged, unreachable or rate_limited, with the
 *          caregivers named as told.
 * @raises not_found for an unknown household or a conversation of another household.
 */
export const flagCaregiver = agentMutation({
  args: {
    householdId: v.id("households"),
    reason: modelFlagReason,
    detail: v.string(),
    conversationId: nullable(v.id("conversations")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<FlagResult> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await flagCaregiverCore(ctx, {
      household,
      reason: args.reason,
      detail: args.detail,
      conversationId: await householdConversation(ctx, household._id, args.conversationId),
      now: clock(args.now),
    });
  },
});

/**
 * purpose: Send a message the senior dictated to family (lib/voiceRouting): a familyMessages
 *          row from the senior, the same rows profile.listMessages shows, plus a text to the
 *          named reachable caregiver or every reachable one.
 * @param householdId: (Id<"households">) Household.
 * @param to: (string | null, optional) The name the senior used; blank or null for the family.
 * @param body: (string) The message.
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @return: (FamilyMessageResult) sent, sent_to_family, unreachable, already_sent or
 *          rate_limited, with the recipients' names.
 * @raises invalid for a blank message; not_found for an unknown household or a conversation
 *         of another household.
 */
export const sendFamilyMessage = agentMutation({
  args: {
    householdId: v.id("households"),
    to: nullable(v.string()),
    body: v.string(),
    conversationId: nullable(v.id("conversations")),
  },
  handler: async (ctx, args): Promise<FamilyMessageResult> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await sendFamilyMessageCore(ctx, {
      household,
      to: args.to ?? "",
      body: args.body,
      conversationId: await householdConversation(ctx, household._id, args.conversationId),
      now: Date.now(),
    });
  },
});

/**
 * purpose: The newest caregiver message for reading aloud ("What did Sarah send?"); marks it
 *          seen (seenAt, which profile.listMessages shows) the first time. Loading the
 *          context never marks it. The returned `seen` is whether it had been seen before.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (MessageView | null) The message, or null when family has sent none.
 * @raises not_found when the household does not exist.
 */
export const readLatestMessage = agentMutation({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MessageView | null> => {
    await loadHousehold(ctx, args.householdId);
    const latest = await latestCaregiverMessage(ctx, args.householdId);
    if (!latest) return null;
    if (latest.row.seenAt === undefined) {
      await ctx.db.patch(latest.row._id, { seenAt: clock(args.now) });
    }
    return latest.view;
  },
});

/**
 * purpose: "Add milk and eggs to the list" (lib/householdList.addSpokenItemsCore).
 * @param householdId: (Id<"households">) Household.
 * @param items: (string[]) The items as said.
 * @return: (AddedItem[]) Per item: added, already_on_list or list_full.
 * @raises not_found when the household does not exist.
 */
export const addListItems = agentMutation({
  args: { householdId: v.id("households"), items: v.array(v.string()) },
  handler: async (ctx, args): Promise<AddedItem[]> => {
    await loadHousehold(ctx, args.householdId);
    return await addSpokenItemsCore(ctx, VOICE_AGENT, args.householdId, args.items, Date.now());
  },
});

/**
 * purpose: "What's on my list?": the open items in the order added.
 * @param householdId: (Id<"households">) Household.
 * @return: (string[]) The items' text (at most 50).
 * @raises not_found when the household does not exist.
 */
export const listItems = agentQuery({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<string[]> => {
    await loadHousehold(ctx, args.householdId);
    return (await openListItems(ctx, args.householdId)).map((i) => i.text);
  },
});

/**
 * purpose: "I bought the milk": tick the open item the words mean
 *          (lib/householdList.tickItemByWordsCore).
 * @param householdId: (Id<"households">) Household.
 * @param item: (string) The words naming the item.
 * @return: (TickItemResult) ticked with the item's text, or not_found / ambiguous.
 * @raises not_found when the household does not exist.
 */
export const tickListItem = agentMutation({
  args: { householdId: v.id("households"), item: v.string() },
  handler: async (ctx, args): Promise<TickItemResult> => {
    await loadHousehold(ctx, args.householdId);
    return await tickItemByWordsCore(ctx, VOICE_AGENT, args.householdId, args.item, Date.now());
  },
});

/**
 * purpose: Open a conversation row when a voice session starts (lib/conversationLog).
 * @param householdId: (Id<"households">) Household.
 * @param deviceId: (Id<"devices"> | null, optional) The device; must belong to the household.
 * @param trigger: (string) What started the session.
 * @param taskInstanceId: (Id<"taskInstances"> | null, optional) The prompting instance; must
 *        belong to the household.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (Id<"conversations">) The new conversation.
 * @raises not_found for an unknown household, device or instance, or one of another household.
 */
export const startConversation = agentMutation({
  args: {
    householdId: v.id("households"),
    deviceId: nullable(v.id("devices")),
    trigger: v.string(),
    taskInstanceId: nullable(v.id("taskInstances")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    await loadHousehold(ctx, args.householdId);
    return await startConversationCore(ctx, {
      householdId: args.householdId,
      deviceId: args.deviceId ?? undefined,
      trigger: args.trigger,
      taskInstanceId: args.taskInstanceId ?? undefined,
      now: clock(args.now),
    });
  },
});

/**
 * purpose: Append one transcript turn to a conversation; content longer than
 *          MAX_TURN_CONTENT_LENGTH (20,000) is cut, not rejected.
 * @param conversationId: (Id<"conversations">) The conversation.
 * @param role: ("user" | "assistant") Who spoke.
 * @param content: (string) What was said.
 * @return: (null)
 * @raises not_found when the conversation does not exist.
 */
export const logTurn = agentMutation({
  args: {
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    await logTurnCore(ctx, args);
    return null;
  },
});

/**
 * purpose: Close a conversation: set endedAt, and the summary when one is given.
 * @param conversationId: (Id<"conversations">) The conversation.
 * @param summary: (string | null, optional) Short summary; blank or null leaves it unset.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (null)
 * @raises not_found when the conversation does not exist.
 */
export const finishConversation = agentMutation({
  args: {
    conversationId: v.id("conversations"),
    summary: nullable(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    await finishConversationCore(ctx, {
      conversationId: args.conversationId,
      summary: args.summary,
      now: clock(args.now),
    });
    return null;
  },
});

/**
 * purpose: Store the questions extracted from a finished conversation, for the digest
 *          (lib/conversationLog.logQuestionsCore; idempotent per conversation).
 * @param conversationId: (Id<"conversations">) The conversation.
 * @param questions: (Array<{question, topic, outcome, toolsUsed, askedAt?}>) At most 50.
 * @return: (number) Rows inserted (0 when the conversation's questions were already logged).
 * @raises not_found when the conversation does not exist; invalid for more than 50 questions.
 */
export const logQuestions = agentMutation({
  args: {
    conversationId: v.id("conversations"),
    questions: v.array(
      v.object({
        question: v.string(),
        topic: v.string(),
        outcome: questionOutcome,
        toolsUsed: v.array(v.string()),
        askedAt: nullable(v.number()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<number> => {
    return await logQuestionsCore(ctx, args.conversationId, args.questions);
  },
});
