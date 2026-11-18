import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "./errors";
import type { QuestionOutcome } from "./validators";

export const MAX_TURN_CONTENT_LENGTH = 20_000;
const MAX_QUESTIONS_PER_CONVERSATION = 50;
const MAX_QUESTION_LENGTH = 500;
const MAX_TOPIC_LENGTH = 80;
const MAX_TOOLS_PER_QUESTION = 20;

interface AskedQuestion {
  question: string;
  topic: string;
  outcome: QuestionOutcome;
  toolsUsed: string[];
  askedAt?: number | null;
}

async function requireInHousehold(
  ctx: QueryCtx,
  householdId: Id<"households">,
  id: Id<"conversations" | "devices" | "taskInstances">,
  label: string,
): Promise<void> {
  const row = await ctx.db.get(id);
  if (!row || row.householdId !== householdId) throw appError("not_found", `${label} not found`);
}

export async function householdConversation(
  ctx: QueryCtx,
  householdId: Id<"households">,
  conversationId: Id<"conversations"> | null | undefined,
): Promise<Id<"conversations"> | undefined> {
  if (!conversationId) return undefined;
  await requireInHousehold(ctx, householdId, conversationId, "Conversation");
  return conversationId;
}

async function loadConversation(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
): Promise<Doc<"conversations">> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) throw appError("not_found", "Conversation not found");
  return conversation;
}

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

function askedWithin(
  conversation: Doc<"conversations">,
  askedAt: number | null | undefined,
): number {
  const latest = conversation.endedAt ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(askedAt ?? conversation.startedAt, conversation.startedAt), latest);
}

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
      askedAt: askedWithin(conversation, q.askedAt),
      question,
      topic,
      outcome: q.outcome,
      toolsUsed: q.toolsUsed.slice(0, MAX_TOOLS_PER_QUESTION),
    });
    inserted += 1;
  }
  return inserted;
}
