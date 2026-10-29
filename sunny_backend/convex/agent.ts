// convex/agent.ts
// Purpose: The API the Python voice agent calls over Convex's HTTP API (POST /api/query and
// /api/mutation), replacing the service-role supabase-py calls. Every function takes
// `agentKey` first and compares it in constant time with the SUNNY_AGENT_KEY deployment env
// var (a missing env var or a mismatch is forbidden); agentQuery and agentMutation wrap that
// check once. The actor is { kind: "agent" }, so the instance cores treat it as the backend.
//
// Trust model: these functions trust the householdId the agent passes. It comes from the
// LiveKit participant metadata written by voice.livekitToken, never from the model, so the
// agent key is the only gate. Anyone holding the key can act for any household.
//
// Clock: an optional `now` (epoch ms) is honored here only (backend callers), else Date.now().
// Instants in results are epoch ms; absent optional values are null. logTurn truncates content
// to MAX_TURN_CONTENT_LENGTH (20,000) characters rather than rejecting it.
//
// Functions: getContext (port of get_agent_context), today, confirmDueTask,
// createSeniorReminder, cancelSeniorReminder, startConversation, logTurn, finishConversation.
//
// Last modified: 2026-10-29

import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  cancelSeniorReminderCore,
  confirmDueTaskCore,
  createSeniorReminderCore,
} from "./instances";
import type { CancelReminderResult, ConfirmDueResult } from "./instances";
import type { Actor } from "./lib/access";
import { loadHousehold } from "./lib/access";
import { appError } from "./lib/errors";
import { householdOccurrences } from "./lib/occurrences";
import { addDays, localDate, localDateTime, localMidnight } from "./lib/time";
import { constantTimeEqual } from "./lib/secretBox";
import { todayInstances } from "./lib/today";
import type { TodayEntry } from "./lib/today";
import type { ConfirmVia } from "./lib/validators";
import { lifeCategory } from "./lib/validators";

const AGENT: Actor = { kind: "agent" };
const EVENT_WINDOW_DAYS = 7;
const MEMORY_LIMIT = 50;
const RECENT_CONVERSATIONS = 5;
const VOICE: ConfirmVia = "voice";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest transcript turn stored; longer content is truncated, not rejected. */
export const MAX_TURN_CONTENT_LENGTH = 20_000;

/** Category order the SQL enum sorted the life profile by. */
const LIFE_CATEGORY_ORDER = lifeCategory.members.map((m) => m.value as string);

/** One as-needed medication with the doses taken since local midnight. */
export interface AsNeededEntry {
  taskId: Id<"tasks">;
  displayLabel: string;
  pillDescription: string | null;
  maxPerDay: number | null;
  minHoursBetween: number | null;
  takenToday: number[];
}

/** Everything the agent knows about a household at the start of a conversation. */
export interface AgentContext {
  household: {
    id: Id<"households">;
    seniorPreferredName: string;
    timezone: string;
    localNow: string;
  };
  today: TodayEntry[];
  asNeeded: AsNeededEntry[];
  events: Array<{
    title: string;
    label: string;
    startsAt: number;
    endsAt: number | null;
    place: string | null;
    visitorName: string | null;
    notes: string | null;
  }>;
  latestMessage: {
    from: string;
    body: string | null;
    hasPhoto: boolean;
    sentAt: number;
    seen: boolean;
  } | null;
  lifeProfile: Array<{ category: string; name: string; details: string | null }>;
  sensitiveTopics: Array<{ topic: string; guidance: string }>;
  memory: Array<{ fact: string; source: string; verified: boolean; notedAt: number }>;
  recentConversations: Array<{ startedAt: number; summary: string }>;
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
 * purpose: Active as-needed medications with the doses taken since local midnight.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AsNeededEntry[]>) Entries in task creation order.
 */
async function asNeededEntries(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AsNeededEntry[]> {
  const midnight = localMidnight(now, household.timezone);
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household_active", (q) => q.eq("householdId", household._id).eq("active", true))
    .collect();
  const entries: AsNeededEntry[] = [];
  for (const task of tasks) {
    if (task.asNeededMaxPerDay === undefined && task.asNeededMinHours === undefined) continue;
    const doses = await ctx.db
      .query("doseLog")
      .withIndex("by_household_task_taken", (q) =>
        q.eq("householdId", household._id).eq("taskId", task._id).gte("takenAt", midnight),
      )
      .collect();
    entries.push({
      taskId: task._id,
      displayLabel: task.displayLabel,
      pillDescription: task.pillDescription ?? null,
      maxPerDay: task.asNeededMaxPerDay ?? null,
      minHoursBetween: task.asNeededMinHours ?? null,
      takenToday: doses.map((d) => d.takenAt),
    });
  }
  return entries;
}

/**
 * purpose: Occurrences in the next 7 days that have not ended yet.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AgentContext["events"]>) Events ordered by start.
 */
async function upcomingEvents(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AgentContext["events"]> {
  const today = localDate(now, household.timezone);
  const occurrences = await householdOccurrences(
    ctx,
    household._id,
    household.timezone,
    today,
    addDays(today, EVENT_WINDOW_DAYS),
  );
  return occurrences
    .filter((o) => (o.endsAt ?? o.startsAt) >= now && o.startsAt < now + EVENT_WINDOW_DAYS * DAY_MS)
    .map((o) => ({
      title: o.event.title,
      label: o.event.label ?? o.event.title,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      place: o.event.place ?? null,
      visitorName: o.event.visitorName ?? null,
      notes: o.event.notes ?? null,
    }));
}

/**
 * purpose: The newest message a caregiver sent, with the sender's display name.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["latestMessage"]>) The message, or null when none.
 */
async function latestCaregiverMessage(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["latestMessage"]> {
  const message = await ctx.db
    .query("familyMessages")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .filter((q) => q.eq(q.field("senderKind"), "caregiver"))
    .first();
  if (!message) return null;
  const senderUserId = message.senderUserId;
  const member =
    senderUserId === undefined
      ? null
      : await ctx.db
          .query("householdMembers")
          .withIndex("by_household_user", (q) =>
            q.eq("householdId", householdId).eq("userId", senderUserId),
          )
          .unique();
  return {
    from: member?.displayName ?? "family",
    body: message.body ?? null,
    hasPhoto: message.photoStorageId !== undefined,
    sentAt: message._creationTime,
    seen: message.seenAt !== undefined,
  };
}

/**
 * purpose: Life profile entries ordered by category (declaration order) then name.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["lifeProfile"]>) The entries.
 */
async function lifeProfile(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["lifeProfile"]> {
  const rows = await ctx.db
    .query("lifeProfileEntries")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  rows.sort(
    (a, b) =>
      LIFE_CATEGORY_ORDER.indexOf(a.category) - LIFE_CATEGORY_ORDER.indexOf(b.category) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return rows.map((r) => ({ category: r.category, name: r.name, details: r.details ?? null }));
}

/**
 * purpose: What the agent remembers: verified facts first, then newest first, at most 50.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["memory"]>) The facts.
 */
async function memoryFacts(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["memory"]> {
  const rows = await ctx.db
    .query("agentMemory")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  rows.sort(
    (a, b) =>
      Number(b.verifiedAt !== undefined) - Number(a.verifiedAt !== undefined) ||
      b._creationTime - a._creationTime,
  );
  return rows.slice(0, MEMORY_LIMIT).map((r) => ({
    fact: r.fact,
    source: r.source,
    verified: r.verifiedAt !== undefined,
    notedAt: r._creationTime,
  }));
}

/**
 * purpose: The newest conversations that have a summary.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["recentConversations"]>) Up to 5, newest first.
 */
async function recentSummaries(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["recentConversations"]> {
  const out: AgentContext["recentConversations"] = [];
  const rows = ctx.db
    .query("conversations")
    .withIndex("by_household_started", (q) => q.eq("householdId", householdId))
    .order("desc");
  for await (const row of rows) {
    if (row.summary === undefined) continue;
    out.push({ startedAt: row.startedAt, summary: row.summary });
    if (out.length >= RECENT_CONVERSATIONS) break;
  }
  return out;
}

/**
 * purpose: Everything the agent knows about a household at the start of a conversation.
 * @param householdId: (Id<"households">) Household, from the participant metadata.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (AgentContext) The context.
 * @raises not_found when the household does not exist.
 */
export const getContext = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<AgentContext> => {
    const now = clock(args.now);
    const household = await loadHousehold(ctx, args.householdId);
    return {
      household: {
        id: household._id,
        seniorPreferredName: household.seniorPreferredName,
        timezone: household.timezone,
        localNow: localDateTime(now, household.timezone),
      },
      today: await todayInstances(ctx, household._id, now),
      asNeeded: await asNeededEntries(ctx, household, now),
      events: await upcomingEvents(ctx, household, now),
      latestMessage: await latestCaregiverMessage(ctx, household._id),
      lifeProfile: await lifeProfile(ctx, household._id),
      sensitiveTopics: (
        await ctx.db
          .query("sensitiveTopics")
          .withIndex("by_household", (q) => q.eq("householdId", household._id))
          .collect()
      ).map((s) => ({ topic: s.topic, guidance: s.guidance })),
      memory: await memoryFacts(ctx, household._id),
      recentConversations: await recentSummaries(ctx, household._id),
    };
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
 * purpose: Confirm the task the senior means, by voice ("I took my pills").
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null, optional) Words from the task's display label.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (ConfirmDueResult) Same shape as instances.confirmDueTask.
 */
export const confirmDueTask = agentMutation({
  args: {
    householdId: v.id("households"),
    label: v.optional(v.union(v.string(), v.null())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ConfirmDueResult> => {
    return await confirmDueTaskCore(
      ctx,
      AGENT,
      { householdId: args.householdId, via: VOICE, label: args.label ?? undefined },
      clock(args.now),
    );
  },
});

/**
 * purpose: Create a reminder the senior asked for.
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
    onDate: v.optional(v.union(v.string(), v.null())),
    days: v.optional(v.union(v.array(v.number()), v.null())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ taskId: Id<"tasks"> }> => {
    const task = await createSeniorReminderCore(
      ctx,
      AGENT,
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
    return await cancelSeniorReminderCore(ctx, AGENT, args, Date.now());
  },
});

/**
 * purpose: Open a conversation row when a voice session starts.
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
    deviceId: v.optional(v.union(v.id("devices"), v.null())),
    trigger: v.string(),
    taskInstanceId: v.optional(v.union(v.id("taskInstances"), v.null())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    await loadHousehold(ctx, args.householdId);
    if (args.deviceId) {
      const device = await ctx.db.get(args.deviceId);
      if (!device || device.householdId !== args.householdId) {
        throw appError("not_found", "Device not found");
      }
    }
    if (args.taskInstanceId) {
      const instance = await ctx.db.get(args.taskInstanceId);
      if (!instance || instance.householdId !== args.householdId) {
        throw appError("not_found", "Task instance not found");
      }
    }
    return await ctx.db.insert("conversations", {
      householdId: args.householdId,
      deviceId: args.deviceId ?? undefined,
      trigger: args.trigger,
      taskInstanceId: args.taskInstanceId ?? undefined,
      startedAt: clock(args.now),
    });
  },
});

/**
 * purpose: Append one transcript turn to a conversation.
 * @param conversationId: (Id<"conversations">) The conversation.
 * @param role: ("user" | "assistant") Who spoke.
 * @param content: (string) What was said; truncated to MAX_TURN_CONTENT_LENGTH characters.
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
    if (!(await ctx.db.get(args.conversationId))) {
      throw appError("not_found", "Conversation not found");
    }
    await ctx.db.insert("conversationTurns", {
      conversationId: args.conversationId,
      role: args.role,
      content: args.content.slice(0, MAX_TURN_CONTENT_LENGTH),
    });
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
    summary: v.optional(v.union(v.string(), v.null())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    if (!(await ctx.db.get(args.conversationId))) {
      throw appError("not_found", "Conversation not found");
    }
    const summary = args.summary?.trim();
    await ctx.db.patch(args.conversationId, {
      endedAt: clock(args.now),
      ...(summary ? { summary } : {}),
    });
    return null;
  },
});
