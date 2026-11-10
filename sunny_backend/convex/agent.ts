// convex/agent.ts
// Purpose: The API the Python voice agent calls over Convex's HTTP API (POST /api/query and
// /api/mutation), replacing the service-role supabase-py calls. Every function takes
// `agentKey` first and compares it in constant time with the SUNNY_AGENT_KEY deployment env
// var (a missing env var or a mismatch is forbidden); agentQuery and agentMutation wrap that
// check once. The actor is { kind: "agent" }, so the instance cores treat it as the backend.
//
// Trust model: these functions trust the householdId the agent passes. It comes from the
// LiveKit participant metadata written by voice.livekitToken, never from the model, so the
// agent key is the only gate. Anyone holding the key can act for any household. A
// conversationId passed together with a householdId must belong to that household.
//
// Clock: an optional `now` (epoch ms) is honored here only (backend callers), else Date.now().
// Instants in results are epoch ms; absent optional values are null. logTurn truncates content
// to MAX_TURN_CONTENT_LENGTH (20,000) characters rather than rejecting it.
//
// Functions: getContext (port of get_agent_context, plus the weather location, the
// caregivers' names and recent question topics), today, medicationStatus (today's scheduled
// medications and the as-needed label facts, fresh), confirmDueTask, snoozeDueTask ("not
// yet"), logAsNeededDose (a self-reported dose, flagging the caregiver past a label limit),
// createSeniorReminder, cancelSeniorReminder, rememberFact (unverified senior memory, never
// overwriting), flagCaregiver, sendFamilyMessage, readLatestMessage (marks it seen),
// startConversation, logTurn, finishConversation, logQuestions (the questions extracted from a
// finished conversation, for the digest).
//
// Memory (limits in lib/memoryLimits.ts): getContext gives the newest verified facts (up to 40)
// and the newest unverified facts in the remaining slots of 50 (always at least 10), reading
// a bounded number of rows; rememberFact stores one trimmed line of at most 300 characters,
// skips a duplicate, and keeps at most 200 unverified senior-stated facts per household.
// Messages: only readLatestMessage (the message read aloud) sets seenAt; getContext never does.
//
// Last modified: 2026-11-09

import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  cancelSeniorReminderCore,
  confirmDueTaskCore,
  createSeniorReminderCore,
  logDoseCore,
  snoozeInstance,
} from "./instances";
import type { CancelReminderResult, ConfirmDueResult } from "./instances";
import { loadHousehold } from "./lib/access";
import { audit } from "./lib/audit";
import { isAnytimeInstance } from "./lib/anytime";
import { doseStatus, limitBreaches } from "./lib/doseLimits";
import type { LocalDay } from "./lib/doseLimits";
import {
  MAX_FACT_LENGTH,
  MAX_UNVERIFIED_SENIOR_FACTS,
  MEMORY_CONTEXT_LIMIT,
  MEMORY_SCAN_LIMIT,
  MEMORY_UNVERIFIED_RESERVE,
  factKey,
  singleLine,
} from "./lib/memoryLimits";
import { appError } from "./lib/errors";
import { householdOccurrences } from "./lib/occurrences";
import {
  addDays,
  formatTime12,
  localDate,
  localDateTime,
  localMidnight,
  localTime,
  zonedInstant,
} from "./lib/time";
import { constantTimeEqual } from "./lib/secretBox";
import { todayInstances } from "./lib/today";
import type { TodayEntry } from "./lib/today";
import type { ConfirmVia } from "./lib/validators";
import { lifeCategory, questionOutcome } from "./lib/validators";
import {
  VOICE_AGENT,
  flagCaregiverCore,
  flagReason,
  householdCaregivers,
  sendFamilyMessageCore,
} from "./lib/voiceRouting";
import type { FamilyMessageResult, FlagResult } from "./lib/voiceRouting";

const EVENT_WINDOW_DAYS = 7;
const RECENT_CONVERSATIONS = 5;
const VOICE: ConfirmVia = "voice";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Doses read back this far for the hours-apart rule, which reaches across midnight. */
const DOSE_LOOKBACK_MS = 2 * DAY_MS;
/** Longest a self-reported dose may be back-dated ("I took one an hour ago"). */
const MAX_DOSE_MINUTES_AGO = 12 * 60;
/** Question topics from this far back are offered to the extractor, so repeats share one. */
const TOPIC_LOOKBACK_MS = 7 * DAY_MS;
const MAX_RECENT_TOPICS = 30;
/** Caps for one logQuestions call. */
const MAX_QUESTIONS_PER_CONVERSATION = 50;
const MAX_QUESTION_LENGTH = 500;
const MAX_TOPIC_LENGTH = 80;
const MAX_TOOLS_PER_QUESTION = 20;
/** Longest transcript turn stored; longer content is truncated, not rejected. */
export const MAX_TURN_CONTENT_LENGTH = 20_000;

/** Category order the SQL enum sorted the life profile by. */
const LIFE_CATEGORY_ORDER = lifeCategory.members.map((m) => m.value as string);

/** One as-needed medication with today's doses and what the label limits mean right now. */
export interface AsNeededEntry {
  taskId: Id<"tasks">;
  displayLabel: string;
  pillDescription: string | null;
  maxPerDay: number | null;
  minHoursBetween: number | null;
  /** Doses since local midnight, ascending. */
  takenToday: number[];
  /** The latest dose (may be before local midnight); null when none in the last two days. */
  lastTakenAt: number | null;
  /** Doses left today under maxPerDay; null without a daily maximum. */
  remainingToday: number | null;
  /** Earliest instant another dose is within the label; null when it already is. */
  nextWithinLabelAt: number | null;
}

/** The household's family message as the agent reads it. */
export interface MessageView {
  from: string;
  body: string | null;
  hasPhoto: boolean;
  sentAt: number;
  seen: boolean;
}

/** Everything the agent knows about a household at the start of a conversation. */
export interface AgentContext {
  household: {
    id: Id<"households">;
    seniorPreferredName: string;
    timezone: string;
    localNow: string;
    weatherLocation: string | null;
  };
  caregivers: Array<{ name: string; onCall: boolean }>;
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
  latestMessage: MessageView | null;
  lifeProfile: Array<{ category: string; name: string; details: string | null }>;
  sensitiveTopics: Array<{ topic: string; guidance: string }>;
  memory: Array<{ fact: string; source: string; verified: boolean; notedAt: number }>;
  recentConversations: Array<{ startedAt: number; summary: string }>;
  /** Distinct question topics of the last 7 days, newest first. */
  recentQuestionTopics: string[];
}

/** Result of medicationStatus. */
export interface MedicationStatus {
  /** Today's scheduled medication entries (see lib/today). */
  scheduled: TodayEntry[];
  asNeeded: AsNeededEntry[];
}

/** Result of snoozeDueTask. */
export interface SnoozeResult {
  status: "snoozed" | "nothing_due" | "not_found" | "ambiguous" | "already_done" | "not_due_yet";
  displayLabel: string | null;
  scheduledTime: string | null;
  snoozedUntil: number | null;
  confirmedAt: number | null;
  options: string[];
}

/** Result of logAsNeededDose. */
export type LogDoseResult =
  | {
      status: "logged";
      medication: AsNeededEntry;
      takenAt: number;
      overDailyMax: boolean;
      tooSoon: boolean;
      /** Caregivers told about a dose past a limit; empty when within the label. */
      flagged: string[];
    }
  | { status: "no_rule" | "not_found" | "ambiguous"; options: string[] };

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
 * purpose: The household-local day containing an instant.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (LocalDay) Local midnight to the next local midnight.
 */
function localDay(household: Doc<"households">, now: number): LocalDay {
  return {
    start: localMidnight(now, household.timezone),
    end: zonedInstant(addDays(localDate(now, household.timezone), 1), "00:00", household.timezone),
  };
}

/**
 * purpose: Check that a conversation the agent names belongs to the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param conversationId: (Id<"conversations"> | null | undefined) The conversation, if any.
 * @return: (Promise<Id<"conversations"> | undefined>) The id, or undefined when none given.
 * @raises not_found for a missing conversation or one of another household.
 */
async function householdConversation(
  ctx: QueryCtx,
  householdId: Id<"households">,
  conversationId: Id<"conversations"> | null | undefined,
): Promise<Id<"conversations"> | undefined> {
  if (!conversationId) return undefined;
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.householdId !== householdId) {
    throw appError("not_found", "Conversation not found");
  }
  return conversationId;
}

/** An as-needed medication task with its recent doses. */
interface AsNeededMed {
  task: Doc<"tasks">;
  /** Dose instants in the last two days, ascending. */
  doses: number[];
}

/**
 * purpose: Active medication tasks with as-needed limits, each with its doses of the last two
 *          days (enough for the hours-apart rule across midnight).
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AsNeededMed[]>) In task creation order.
 */
async function asNeededMeds(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AsNeededMed[]> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household_active", (q) => q.eq("householdId", household._id).eq("active", true))
    .collect();
  const since = Math.min(localMidnight(now, household.timezone), now - DOSE_LOOKBACK_MS);
  const meds: AsNeededMed[] = [];
  for (const task of tasks) {
    if (task.type !== "medication") continue;
    if (task.asNeededMaxPerDay === undefined && task.asNeededMinHours === undefined) continue;
    const doses = await ctx.db
      .query("doseLog")
      .withIndex("by_household_task_taken", (q) =>
        q.eq("householdId", household._id).eq("taskId", task._id).gte("takenAt", since),
      )
      .collect();
    meds.push({ task, doses: doses.map((d) => d.takenAt) });
  }
  return meds;
}

/**
 * purpose: The agent's view of one as-needed medication at an instant.
 * @param med: (AsNeededMed) The task and its recent doses.
 * @param day: (LocalDay) The local day containing now.
 * @param now: (number) Epoch ms.
 * @return: (AsNeededEntry) The entry.
 */
function asNeededEntry(med: AsNeededMed, day: LocalDay, now: number): AsNeededEntry {
  const limits = {
    maxPerDay: med.task.asNeededMaxPerDay ?? null,
    minHoursBetween: med.task.asNeededMinHours ?? null,
  };
  return {
    taskId: med.task._id,
    displayLabel: med.task.displayLabel,
    pillDescription: med.task.pillDescription ?? null,
    ...limits,
    ...doseStatus(limits, med.doses, day, now),
  };
}

/**
 * purpose: Active as-needed medications with today's doses and the label facts right now.
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
  const day = localDay(household, now);
  return (await asNeededMeds(ctx, household, now)).map((m) => asNeededEntry(m, day, now));
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
 * @return: (Promise<{row: Doc<"familyMessages">; view: MessageView} | null>) The row and its
 *          view, or null when none.
 */
async function latestCaregiverMessage(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<{ row: Doc<"familyMessages">; view: MessageView } | null> {
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
    row: message,
    view: {
      from: member?.displayName ?? "family",
      body: message.body ?? null,
      hasPhoto: message.photoStorageId !== undefined,
      sentAt: message._creationTime,
      seen: message.seenAt !== undefined,
    },
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
 * purpose: The household's newest agentMemory rows, at most MEMORY_SCAN_LIMIT.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"agentMemory">[]>) Rows, newest first.
 */
async function recentMemoryRows(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"agentMemory">[]> {
  return await ctx.db
    .query("agentMemory")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .take(MEMORY_SCAN_LIMIT);
}

/**
 * purpose: What the agent remembers, at most MEMORY_CONTEXT_LIMIT (50) facts: the newest
 *          verified facts, up to the limit minus MEMORY_UNVERIFIED_RESERVE (10), then the
 *          newest unverified facts in the slots left (always at least the reserve), so things
 *          the senior said stay in context however many verified facts exist.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["memory"]>) Verified facts, then unverified, each newest
 *          first.
 */
async function memoryFacts(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["memory"]> {
  const rows = await recentMemoryRows(ctx, householdId);
  const verified = rows
    .filter((r) => r.verifiedAt !== undefined)
    .slice(0, MEMORY_CONTEXT_LIMIT - MEMORY_UNVERIFIED_RESERVE);
  const unverified = rows
    .filter((r) => r.verifiedAt === undefined)
    .slice(0, MEMORY_CONTEXT_LIMIT - verified.length);
  return [...verified, ...unverified].map((r) => ({
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
 * purpose: Distinct question topics of the last 7 days, so the post-call extractor can reuse
 *          a topic for a repeated question.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<string[]>) Up to 30 topics, newest first.
 */
async function recentQuestionTopics(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<string[]> {
  const topics = new Set<string>();
  const rows = ctx.db
    .query("agentQuestions")
    .withIndex("by_household_asked", (q) =>
      q.eq("householdId", householdId).gte("askedAt", now - TOPIC_LOOKBACK_MS),
    )
    .order("desc");
  for await (const row of rows) {
    topics.add(row.topic);
    if (topics.size >= MAX_RECENT_TOPICS) break;
  }
  return [...topics];
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
    const caregivers = await householdCaregivers(ctx, household._id);
    return {
      household: {
        id: household._id,
        seniorPreferredName: household.seniorPreferredName,
        timezone: household.timezone,
        localNow: localDateTime(now, household.timezone),
        weatherLocation: household.weatherLocation ?? null,
      },
      caregivers: caregivers.map((m) => ({
        name: m.displayName,
        onCall: m.userId === household.onCallUserId,
      })),
      today: await todayInstances(ctx, household._id, now),
      asNeeded: await asNeededEntries(ctx, household, now),
      events: await upcomingEvents(ctx, household, now),
      latestMessage: (await latestCaregiverMessage(ctx, household._id))?.view ?? null,
      lifeProfile: await lifeProfile(ctx, household._id),
      sensitiveTopics: (
        await ctx.db
          .query("sensitiveTopics")
          .withIndex("by_household", (q) => q.eq("householdId", household._id))
          .collect()
      ).map((s) => ({ topic: s.topic, guidance: s.guidance })),
      memory: await memoryFacts(ctx, household._id),
      recentConversations: await recentSummaries(ctx, household._id),
      recentQuestionTopics: await recentQuestionTopics(ctx, household._id, now),
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
 * purpose: The facts for a medication question, read fresh: today's scheduled medications
 *          with their state and confirmation time, and each as-needed medication's label limits,
 *          doses today and when another would be within the label.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (MedicationStatus) Scheduled and as-needed facts.
 * @raises not_found when the household does not exist.
 */
export const medicationStatus = agentQuery({
  args: { householdId: v.id("households"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MedicationStatus> => {
    const now = clock(args.now);
    const household = await loadHousehold(ctx, args.householdId);
    const entries = await todayInstances(ctx, household._id, now);
    return {
      scheduled: entries.filter((e) => e.type === "medication"),
      asNeeded: await asNeededEntries(ctx, household, now),
    };
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
      VOICE_AGENT,
      { householdId: args.householdId, via: VOICE, label: args.label ?? undefined },
      clock(args.now),
    );
  },
});

/**
 * purpose: Build a SnoozeResult.
 * @param status: (SnoozeResult["status"]) The outcome.
 * @param entry: (TodayEntry | null) The entry it is about, if one.
 * @param extra: (Partial<SnoozeResult>) Fields to set.
 * @return: (SnoozeResult) The result with every other field null or empty.
 */
function snoozeResult(
  status: SnoozeResult["status"],
  entry: TodayEntry | null,
  extra: Partial<SnoozeResult> = {},
): SnoozeResult {
  return {
    status,
    displayLabel: entry?.displayLabel ?? null,
    scheduledTime: entry?.scheduledTime ?? null,
    snoozedUntil: null,
    confirmedAt: entry?.confirmedAt ?? null,
    options: [],
    ...extra,
  };
}

/**
 * purpose: "Not yet": snooze the senior prompts of the task that is due by 15 minutes (the
 *          default of instances.snoozeInstance; caregiver alerts are not delayed). Without a
 *          label it is the earliest due timed task, as for "Done"; with one, the due task whose
 *          display label contains it. A matching task already done reports when; one still
 *          upcoming reports not_due_yet.
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null, optional) Words from the task's display label.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (SnoozeResult) The outcome and the task it was about.
 */
export const snoozeDueTask = agentMutation({
  args: {
    householdId: v.id("households"),
    label: v.optional(v.union(v.string(), v.null())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SnoozeResult> => {
    const now = clock(args.now);
    await loadHousehold(ctx, args.householdId);
    const entries = await todayInstances(ctx, args.householdId, now);
    /**
     * purpose: Whether an entry is open for confirmation right now.
     * @param e: (TodayEntry) The entry.
     * @return: (boolean) True when due or escalated.
     */
    const isDue = (e: TodayEntry): boolean => e.state === "due" || e.state === "escalated";
    const label = (args.label ?? "").trim().toLowerCase();
    let due: TodayEntry[];
    if (label === "") {
      due = entries.filter((e) => isDue(e) && !isAnytimeInstance(e)).slice(0, 1);
      if (due.length === 0) return snoozeResult("nothing_due", null);
    } else {
      const matches = entries.filter((e) => e.displayLabel.toLowerCase().includes(label));
      if (matches.length === 0) return snoozeResult("not_found", null);
      due = matches.filter(isDue);
      if (due.length === 0) {
        const done = matches.filter((e) => e.state === "confirmed" || e.state === "resolved");
        if (done.length > 0) return snoozeResult("already_done", done.at(-1)!);
        const upcoming = matches.find((e) => e.state === "upcoming");
        return upcoming ? snoozeResult("not_due_yet", upcoming) : snoozeResult("nothing_due", null);
      }
      if (due.length > 1) {
        return snoozeResult("ambiguous", null, { options: due.map((e) => e.displayLabel) });
      }
    }
    const entry = due[0]!;
    const row = await snoozeInstance(ctx, VOICE_AGENT, { instanceId: entry.instanceId }, now);
    return snoozeResult("snoozed", entry, { snoozedUntil: row.snoozedUntil ?? null });
  },
});

/**
 * purpose: Pick the as-needed medication the senior means: by words in its display label,
 *          caregiver title or pill description, or the only one when no words are given.
 * @param meds: (AsNeededMed[]) The household's as-needed medications.
 * @param label: (string) Lower-cased words, or "" for none.
 * @return: (AsNeededMed | LogDoseResult) The medication, or the no_rule, not_found or
 *          ambiguous result.
 */
function pickAsNeeded(meds: AsNeededMed[], label: string): AsNeededMed | LogDoseResult {
  const options = meds.map((m) => m.task.displayLabel);
  if (meds.length === 0) return { status: "no_rule", options };
  const matches =
    label === ""
      ? meds
      : meds.filter((m) =>
          [m.task.displayLabel, m.task.title, m.task.pillDescription ?? ""].some((text) =>
            text.toLowerCase().includes(label),
          ),
        );
  if (matches.length === 0) return { status: "not_found", options };
  if (matches.length > 1)
    return { status: "ambiguous", options: matches.map((m) => m.task.displayLabel) };
  return matches[0]!;
}

/**
 * purpose: The sentence a caregiver gets when a self-reported dose goes past a label limit.
 * @param household: (Doc<"households">) The household.
 * @param entry: (AsNeededEntry) The medication after the dose.
 * @param takenAt: (number) The dose, epoch ms.
 * @param breaches: ({overDailyMax, tooSoon}) Which limits it went past.
 * @return: (string) For example "Margaret reported taking Pain reliever at 3:10 PM. That is 4
 *          today; the label says up to 3 a day."
 */
function limitFlagDetail(
  household: Doc<"households">,
  entry: AsNeededEntry,
  takenAt: number,
  breaches: { overDailyMax: boolean; tooSoon: boolean },
): string {
  /**
   * purpose: A household-local 12-hour time.
   * @param t: (number) Epoch ms.
   * @return: (string) For example "3:10 PM".
   */
  const at = (t: number): string => formatTime12(localTime(t, household.timezone));
  const parts = [
    `${household.seniorPreferredName} reported taking ${entry.displayLabel} at ${at(takenAt)}.`,
  ];
  if (breaches.overDailyMax) {
    parts.push(
      `That is ${entry.takenToday.length} today; the label says up to ${entry.maxPerDay} a day.`,
    );
  }
  if (breaches.tooSoon) {
    parts.push(`The label says at least ${entry.minHoursBetween} hours apart.`);
  }
  return parts.join(" ");
}

/**
 * purpose: Log an as-needed dose the senior says they took (through instances.logDoseCore,
 *          reported via voice) and return the label facts afterwards. A dose past the daily
 *          maximum or closer than the minimum hours to another flags the caregiver
 *          (reason medication_limit). Never logs anything when no as-needed rule matches.
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null, optional) Words naming the medication; may be omitted when
 *        the household has only one as-needed medication.
 * @param minutesAgo: (number | null, optional) Whole minutes since the dose, 0..720; default 0.
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (LogDoseResult) logged with the facts and any flag, or no_rule / not_found /
 *          ambiguous with the medication labels on file.
 * @raises invalid for minutesAgo outside 0..720 or not whole; not_found for a conversation of
 *         another household.
 */
export const logAsNeededDose = agentMutation({
  args: {
    householdId: v.id("households"),
    label: v.optional(v.union(v.string(), v.null())),
    minutesAgo: v.optional(v.union(v.number(), v.null())),
    conversationId: v.optional(v.union(v.id("conversations"), v.null())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LogDoseResult> => {
    const now = clock(args.now);
    const household = await loadHousehold(ctx, args.householdId);
    const conversationId = await householdConversation(ctx, household._id, args.conversationId);
    const minutesAgo = args.minutesAgo ?? 0;
    if (!Number.isInteger(minutesAgo) || minutesAgo < 0 || minutesAgo > MAX_DOSE_MINUTES_AGO) {
      throw appError("invalid", "minutesAgo must be a whole number from 0 to 720");
    }
    const picked = pickAsNeeded(
      await asNeededMeds(ctx, household, now),
      (args.label ?? "").trim().toLowerCase(),
    );
    if ("status" in picked) return picked;
    const takenAt = now - minutesAgo * 60_000;
    await logDoseCore(
      ctx,
      VOICE_AGENT,
      { householdId: household._id, taskId: picked.task._id, takenAt, via: VOICE },
      now,
    );
    const day = localDay(household, now);
    const limits = {
      maxPerDay: picked.task.asNeededMaxPerDay ?? null,
      minHoursBetween: picked.task.asNeededMinHours ?? null,
    };
    const breaches = limitBreaches(limits, picked.doses, takenAt, day);
    const medication = asNeededEntry({ ...picked, doses: [...picked.doses, takenAt] }, day, now);
    let flagged: string[] = [];
    if (breaches.overDailyMax || breaches.tooSoon) {
      const flag = await flagCaregiverCore(ctx, {
        household,
        reason: "medication_limit",
        detail: limitFlagDetail(household, medication, takenAt, breaches),
        conversationId,
        now,
      });
      flagged = flag.notified;
    }
    return { status: "logged", medication, takenAt, ...breaches, flagged };
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
 * purpose: Remember something the senior said ("Remember that...", "I put my glasses in the
 *          hall drawer"): a new agentMemory row with source senior, unverified, linked to the
 *          conversation. The fact is stored as one trimmed line cut to MAX_FACT_LENGTH (300).
 *          A fact whose text is already on file (case-insensitive, whitespace collapsed)
 *          stores nothing and reports already_known. No existing row is edited or verified;
 *          the only rows removed are the household's oldest unverified senior-stated facts
 *          beyond MAX_UNVERIFIED_SENIOR_FACTS (200), so conversation cannot grow the table
 *          without limit. Reads at most MEMORY_SCAN_LIMIT rows, newest first.
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
    conversationId: v.optional(v.union(v.id("conversations"), v.null())),
  },
  handler: async (ctx, args): Promise<{ status: "saved" | "already_known" }> => {
    const household = await loadHousehold(ctx, args.householdId);
    const conversationId = await householdConversation(ctx, household._id, args.conversationId);
    const fact = singleLine(args.fact).slice(0, MAX_FACT_LENGTH).trim();
    if (fact === "") throw appError("invalid", "The fact cannot be blank");
    const recent = await recentMemoryRows(ctx, household._id);
    const key = factKey(fact);
    if (recent.some((r) => factKey(r.fact) === key)) return { status: "already_known" };
    const memoryId = await ctx.db.insert("agentMemory", {
      householdId: household._id,
      fact,
      source: "senior",
      conversationId,
    });
    // The new row is the newest unverified senior fact; keep MAX - 1 of the older ones.
    const olderSenior = recent.filter((r) => r.source === "senior" && r.verifiedAt === undefined);
    for (const row of olderSenior.slice(MAX_UNVERIFIED_SENIOR_FACTS - 1)) {
      await ctx.db.delete(row._id);
    }
    await audit(ctx, {
      householdId: household._id,
      actor: VOICE_AGENT,
      action: "remember",
      entity: "agentMemory",
      entityId: memoryId,
      detail: { conversationId: conversationId ?? null },
    });
    return { status: "saved" };
  },
});

/**
 * purpose: Ask the on-call caregiver (or every caregiver) to look in, through the
 *          notification outbox, with an audit row (lib/voiceRouting.flagCaregiverCore).
 * @param householdId: (Id<"households">) Household.
 * @param reason: (FlagReason) medication_limit, symptom, money_request, scam, distress or
 *        help_requested.
 * @param detail: (string) A short description for the caregiver.
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @param now: (number, optional) Epoch ms; backend clock.
 * @return: (FlagResult) flagged or already_flagged, with the caregivers' names.
 * @raises not_found for an unknown household or a conversation of another household.
 */
export const flagCaregiver = agentMutation({
  args: {
    householdId: v.id("households"),
    reason: flagReason,
    detail: v.string(),
    conversationId: v.optional(v.union(v.id("conversations"), v.null())),
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
 * purpose: Send a message the senior dictated to family ("Tell Sarah I'm home"): a
 *          familyMessages row from the senior plus a notification to the named caregiver, or
 *          to everyone (lib/voiceRouting.sendFamilyMessageCore).
 * @param householdId: (Id<"households">) Household.
 * @param to: (string | null, optional) The name the senior used; blank or null for the family.
 * @param body: (string) The message.
 * @param conversationId: (Id<"conversations"> | null, optional) The conversation.
 * @return: (FamilyMessageResult) sent or sent_to_family, with the recipients' names.
 * @raises invalid for a blank message; not_found for an unknown household or a conversation
 *         of another household.
 */
export const sendFamilyMessage = agentMutation({
  args: {
    householdId: v.id("households"),
    to: v.optional(v.union(v.string(), v.null())),
    body: v.string(),
    conversationId: v.optional(v.union(v.id("conversations"), v.null())),
  },
  handler: async (ctx, args): Promise<FamilyMessageResult> => {
    const household = await loadHousehold(ctx, args.householdId);
    return await sendFamilyMessageCore(ctx, {
      household,
      to: args.to ?? "",
      body: args.body,
      conversationId: await householdConversation(ctx, household._id, args.conversationId),
    });
  },
});

/**
 * purpose: The newest family message for reading aloud ("What did Sarah send?"); marks it
 *          seen (seenAt) the first time. The returned `seen` is whether it had been seen before.
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
    await loadConversation(ctx, args.conversationId);
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
    await loadConversation(ctx, args.conversationId);
    const summary = args.summary?.trim();
    await ctx.db.patch(args.conversationId, {
      endedAt: clock(args.now),
      ...(summary ? { summary } : {}),
    });
    return null;
  },
});

/**
 * purpose: Insert one agentQuestions row per question extracted from a finished
 *          conversation (memory.py does the extraction after the call, so logging adds no
 *          spoken latency). The household comes from the conversation. Text is trimmed and
 *          cut to the caps rather than rejected; the topic is lower-cased so repeats share it;
 *          a blank question or topic is skipped; askedAt defaults to the conversation start.
 * @param conversationId: (Id<"conversations">) The conversation.
 * @param questions: (Array<{question, topic, outcome, toolsUsed, askedAt?}>) At most 50.
 * @return: (number) Rows inserted.
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
        askedAt: v.optional(v.union(v.number(), v.null())),
      }),
    ),
  },
  handler: async (ctx, args): Promise<number> => {
    const conversation = await loadConversation(ctx, args.conversationId);
    if (args.questions.length > MAX_QUESTIONS_PER_CONVERSATION) {
      throw appError("invalid", "Too many questions for one conversation");
    }
    let inserted = 0;
    for (const q of args.questions) {
      const question = q.question.trim().slice(0, MAX_QUESTION_LENGTH);
      const topic = q.topic.trim().toLowerCase().slice(0, MAX_TOPIC_LENGTH);
      if (question === "" || topic === "") continue;
      await ctx.db.insert("agentQuestions", {
        householdId: conversation.householdId,
        conversationId: conversation._id,
        askedAt: q.askedAt ?? conversation.startedAt,
        question,
        topic,
        outcome: q.outcome,
        toolsUsed: q.toolsUsed.slice(0, MAX_TOOLS_PER_QUESTION),
      });
      inserted += 1;
    }
    return inserted;
  },
});
