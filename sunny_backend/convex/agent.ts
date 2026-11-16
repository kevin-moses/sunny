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
import type { SpokenItem, TickItemResult } from "./lib/householdList";
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

function nullable<T extends Validator<unknown, "required", string>>(validator: T) {
  return v.optional(v.union(validator, v.null()));
}

export function requireAgentKey(agentKey: string): void {
  const expected = process.env.SUNNY_AGENT_KEY;
  if (!expected || !constantTimeEqual(agentKey, expected)) {
    throw appError("forbidden", "Invalid agent key");
  }
}

const agentQuery = customQuery(query, {
  args: { agentKey: v.string() },
  input: async (_ctx, { agentKey }) => {
    requireAgentKey(agentKey);
    return { ctx: {}, args: {} };
  },
});

const agentMutation = customMutation(mutation, {
  args: { agentKey: v.string() },
  input: async (_ctx, { agentKey }) => {
    requireAgentKey(agentKey);
    return { ctx: {}, args: {} };
  },
});

function clock(now: number | undefined): number {
  return now ?? Date.now();
}

export const getContext = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<AgentContext> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await buildAgentContext(ctx, household, clock(args.now));
  },
});

export const today = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<TodayEntry[]> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await todayInstances(ctx, household._id, clock(args.now), null);
  },
});

export const medicationStatus = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MedicationStatus> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await medicationStatusCore(ctx, household, clock(args.now));
  },
});

export const confirmDueTask = agentMutation({
  args: {
    householdId: v.id("households"),
    label: nullable(v.string()),
    step: nullable(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ConfirmDueResult> => {
    return await confirmDueTaskCore(
      ctx,
      VOICE_AGENT,
      {
        householdId: args.householdId,
        via: "voice",
        label: args.label ?? undefined,
        step: args.step ?? undefined,
      },
      clock(args.now),
    );
  },
});

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

export const logAsNeededDose = agentMutation({
  args: {
    householdId: v.id("households"),
    label: nullable(v.string()),
    minutesAgo: nullable(v.number()),
    another: nullable(v.boolean()),
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
      another: args.another ?? false,
      dueScheduled: () => dueScheduledMedication(ctx, household._id, now),
      conversationId: await householdConversation(ctx, household._id, args.conversationId),
      now,
    });
  },
});

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

export const cancelSeniorReminder = agentMutation({
  args: { householdId: v.id("households"), query: v.string() },
  handler: async (ctx, args): Promise<CancelReminderResult> => {
    return await cancelSeniorReminderCore(ctx, VOICE_AGENT, args, Date.now());
  },
});

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

export const addListItems = agentMutation({
  args: { householdId: v.id("households"), items: v.array(v.string()) },
  handler: async (ctx, args): Promise<SpokenItem[]> => {
    await loadHousehold(ctx, args.householdId);
    return await addSpokenItemsCore(ctx, VOICE_AGENT, args.householdId, args.items, Date.now());
  },
});

export const listItems = agentQuery({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<string[]> => {
    await loadHousehold(ctx, args.householdId);
    return (await openListItems(ctx, args.householdId)).map((i) => i.text);
  },
});

export const tickListItem = agentMutation({
  args: { householdId: v.id("households"), item: v.string() },
  handler: async (ctx, args): Promise<TickItemResult> => {
    await loadHousehold(ctx, args.householdId);
    return await tickItemByWordsCore(ctx, VOICE_AGENT, args.householdId, args.item, Date.now());
  },
});

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
