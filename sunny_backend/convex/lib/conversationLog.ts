// lib/conversationLog.ts
// Purpose: The voice conversation record the agent keeps (agent.ts startConversation, logTurn,
// finishConversation, logQuestions), and the check that a conversation the agent names belongs
// to the household it acts for. Rules:
// - A conversation's device and prompting task instance must belong to its household.
// - A transcript turn longer than MAX_TURN_CONTENT_LENGTH is cut, not rejected.
// - Finishing sets endedAt, and the summary only when a non-blank one is given (the agent
//   finishes once before its post-call model call and again with the summary).
// - Questions (memory.py extracts them after the call): at most 50 per conversation, text cut
//   to its caps, topics lower-cased so repeats share one, blank ones skipped, askedAt never
//   before the conversation start; once any question of a conversation is logged, a later call
//   inserts nothing (idempotent per conversation).
//
// Last modified: 2026-11-09

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "./errors";
import type { QuestionOutcome } from "./validators";

/** Longest transcript turn stored; longer content is truncated, not rejected. */
export const MAX_TURN_CONTENT_LENGTH = 20_000;
/** Caps for one logQuestions call. */
const MAX_QUESTIONS_PER_CONVERSATION = 50;
const MAX_QUESTION_LENGTH = 500;
const MAX_TOPIC_LENGTH = 80;
const MAX_TOOLS_PER_QUESTION = 20;

/** One question as memory.py sends it. */
interface AskedQuestion {
  question: string;
  topic: string;
  outcome: QuestionOutcome;
  toolsUsed: string[];
  askedAt?: number | null;
}

/**
 * purpose: Check that a row the agent names exists and belongs to the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param id: (Id<"conversations" | "devices" | "taskInstances">) The row.
 * @param label: (string) What it is, for the error message ("Conversation").
 * @return: (Promise<void>)
 * @raises not_found for a missing row or one of another household.
 */
async function requireInHousehold(
  ctx: QueryCtx,
  householdId: Id<"households">,
  id: Id<"conversations" | "devices" | "taskInstances">,
  label: string,
): Promise<void> {
  const row = await ctx.db.get(id);
  if (!row || row.householdId !== householdId) throw appError("not_found", `${label} not found`);
}

/**
 * purpose: Check that a conversation the agent names belongs to the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param conversationId: (Id<"conversations"> | null | undefined) The conversation, if any.
 * @return: (Promise<Id<"conversations"> | undefined>) The id, or undefined when none given.
 * @raises not_found for a missing conversation or one of another household.
 */
export async function householdConversation(
  ctx: QueryCtx,
  householdId: Id<"households">,
  conversationId: Id<"conversations"> | null | undefined,
): Promise<Id<"conversations"> | undefined> {
  if (!conversationId) return undefined;
  await requireInHousehold(ctx, householdId, conversationId, "Conversation");
  return conversationId;
}

/**
 * purpose: Load a conversation the agent names.
 * @param ctx: (QueryCtx) Context.
 * @param conversationId: (Id<"conversations">) The conversation.
 * @return: (Promise<Doc<"conversations">>) The row.
 * @raises not_found when it does not exist.
 */
async function loadConversation(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
): Promise<Doc<"conversations">> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) throw appError("not_found", "Conversation not found");
  return conversation;
}

/**
 * purpose: Open a conversation row when a voice session starts.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({householdId, deviceId, trigger, taskInstanceId, now}) The session.
 * @return: (Promise<Id<"conversations">>) The new conversation.
 * @raises not_found for a device or instance that is missing or of another household.
 */
export async function startConversationCore(
  ctx: MutationCtx,
  args: {
    householdId: Id<"households">;
    deviceId?: Id<"devices">;
    trigger: string;
    taskInstanceId?: Id<"taskInstances">;
    now: number;
  },
): Promise<Id<"conversations">> {
  if (args.deviceId) await requireInHousehold(ctx, args.householdId, args.deviceId, "Device");
  if (args.taskInstanceId) {
    await requireInHousehold(ctx, args.householdId, args.taskInstanceId, "Task instance");
  }
  return await ctx.db.insert("conversations", {
    householdId: args.householdId,
    deviceId: args.deviceId,
    trigger: args.trigger,
    taskInstanceId: args.taskInstanceId,
    startedAt: args.now,
  });
}

/**
 * purpose: Append one transcript turn.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({conversationId, role, content}) The turn.
 * @return: (Promise<void>) Resolves when stored.
 * @raises not_found when the conversation does not exist.
 */
export async function logTurnCore(
  ctx: MutationCtx,
  args: { conversationId: Id<"conversations">; role: "user" | "assistant"; content: string },
): Promise<void> {
  await loadConversation(ctx, args.conversationId);
  await ctx.db.insert("conversationTurns", {
    conversationId: args.conversationId,
    role: args.role,
    content: args.content.slice(0, MAX_TURN_CONTENT_LENGTH),
  });
}

/**
 * purpose: Set a conversation's end time, and its summary when a non-blank one is given.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({conversationId, summary, now}) The conversation, summary and clock.
 * @return: (Promise<void>) Resolves when patched.
 * @raises not_found when the conversation does not exist.
 */
export async function finishConversationCore(
  ctx: MutationCtx,
  args: { conversationId: Id<"conversations">; summary?: string | null; now: number },
): Promise<void> {
  await loadConversation(ctx, args.conversationId);
  const summary = args.summary?.trim();
  await ctx.db.patch(args.conversationId, {
    endedAt: args.now,
    ...(summary ? { summary } : {}),
  });
}

/**
 * purpose: Store the questions of a finished conversation (see the header for the rules).
 * @param ctx: (MutationCtx) Context.
 * @param conversationId: (Id<"conversations">) The conversation.
 * @param questions: (AskedQuestion[]) At most 50.
 * @return: (Promise<number>) Rows inserted (0 when already logged).
 * @raises not_found when the conversation does not exist; invalid for more than 50 questions.
 */
export async function logQuestionsCore(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  questions: AskedQuestion[],
): Promise<number> {
  const conversation = await loadConversation(ctx, conversationId);
  if (questions.length > MAX_QUESTIONS_PER_CONVERSATION) {
    throw appError("invalid", "Too many questions for one conversation");
  }
  const logged = await ctx.db
    .query("agentQuestions")
    .withIndex("by_household_asked", (q) =>
      q.eq("householdId", conversation.householdId).gte("askedAt", conversation.startedAt),
    )
    .filter((q) => q.eq(q.field("conversationId"), conversation._id))
    .first();
  if (logged) return 0;
  let inserted = 0;
  for (const q of questions) {
    const question = q.question.trim().slice(0, MAX_QUESTION_LENGTH);
    const topic = q.topic.trim().toLowerCase().slice(0, MAX_TOPIC_LENGTH);
    if (question === "" || topic === "") continue;
    await ctx.db.insert("agentQuestions", {
      householdId: conversation.householdId,
      conversationId: conversation._id,
      askedAt: Math.max(q.askedAt ?? conversation.startedAt, conversation.startedAt),
      question,
      topic,
      outcome: q.outcome,
      toolsUsed: q.toolsUsed.slice(0, MAX_TOOLS_PER_QUESTION),
    });
    inserted += 1;
  }
  return inserted;
}
