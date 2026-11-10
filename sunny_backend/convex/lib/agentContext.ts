// lib/agentContext.ts
// Purpose: What the voice agent knows about a household at the start of a conversation
// (agent.getContext), and the newest caregiver message it reads aloud (agent.readLatestMessage).
// One builder assembles: the household and its weather location, the caregivers' names (and
// who is on call), today's schedule (lib/today), the as-needed medication facts
// (lib/voiceDoses), the next 7 days of events, the newest caregiver message, the life profile
// and the agent's memory window in the order the caregiver app lists them (lib/profileReads),
// the sensitive-topic playbook, the newest conversation summaries, the question topics of the
// last week (so the post-call extractor reuses a topic for a repeat), and the household list
// (items only when short). Loading the context never marks a message seen.
//
// Last modified: 2026-11-09

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { LIST_CONTEXT_MAX, openListItems } from "./householdList";
import { householdOccurrences } from "./occurrences";
import { findMember } from "./access";
import { agentMemoryWindow, entriesInOrder } from "./profileReads";
import { DAY_MS, addDays, localDate, localDateTime } from "./time";
import { todayInstances } from "./today";
import type { TodayEntry } from "./today";
import { asNeededEntries } from "./voiceDoses";
import type { AsNeededEntry } from "./voiceDoses";
import { householdCaregivers } from "./voiceRouting";

/** Days of events in the context. */
const EVENT_WINDOW_DAYS = 7;
/** Conversation summaries in the context. */
const RECENT_CONVERSATIONS = 5;
/** Question topics from this far back are offered to the extractor. */
const TOPIC_LOOKBACK_MS = 7 * DAY_MS;
const MAX_RECENT_TOPICS = 30;

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
  /** The household list: how many items are open, and their text when there are at most 8. */
  list: { openCount: number; items: string[] };
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
 * purpose: The newest message a caregiver sent (profile.sendMessage), with the sender's
 *          display name.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<{row: Doc<"familyMessages">; view: MessageView} | null>) The row and its
 *          view, or null when none.
 */
export async function latestCaregiverMessage(
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
  const member =
    message.senderUserId === undefined
      ? null
      : await findMember(ctx, householdId, message.senderUserId);
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
 * purpose: Life profile entries in the order the caregiver app lists them (entriesInOrder).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["lifeProfile"]>) The entries.
 */
async function lifeProfile(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["lifeProfile"]> {
  const rows = await entriesInOrder(ctx, householdId);
  return rows.map((r) => ({ category: r.category, name: r.name, details: r.details ?? null }));
}

/**
 * purpose: What the agent remembers: the memory window of lib/profileReads, in its order.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["memory"]>) At most 50 facts, verified first.
 */
async function memoryFacts(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["memory"]> {
  return (await agentMemoryWindow(ctx, householdId)).map((r) => ({
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
 * purpose: Distinct question topics of the last 7 days.
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
 * purpose: The household list for the context: the open count, and the items when there are
 *          at most LIST_CONTEXT_MAX (a longer list is read with the listItems tool).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<AgentContext["list"]>) The summary.
 */
async function listSummary(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["list"]> {
  const open = await openListItems(ctx, householdId);
  return {
    openCount: open.length,
    items: open.length <= LIST_CONTEXT_MAX ? open.map((i) => i.text) : [],
  };
}

/**
 * purpose: Build the agent's context for a household at an instant.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AgentContext>) The context.
 */
export async function buildAgentContext(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AgentContext> {
  const id = household._id;
  // The parts are independent reads, so they run together.
  const [
    caregivers,
    topics,
    today,
    asNeeded,
    events,
    latestMessage,
    lifeProfileRows,
    memory,
    recentConversations,
    questionTopics,
    list,
  ] = await Promise.all([
    householdCaregivers(ctx, id),
    ctx.db
      .query("sensitiveTopics")
      .withIndex("by_household", (q) => q.eq("householdId", id))
      .collect(),
    todayInstances(ctx, id, now),
    asNeededEntries(ctx, household, now),
    upcomingEvents(ctx, household, now),
    latestCaregiverMessage(ctx, id),
    lifeProfile(ctx, id),
    memoryFacts(ctx, id),
    recentSummaries(ctx, id),
    recentQuestionTopics(ctx, id, now),
    listSummary(ctx, id),
  ]);
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
    today,
    asNeeded,
    events,
    latestMessage: latestMessage?.view ?? null,
    lifeProfile: lifeProfileRows,
    sensitiveTopics: topics.map((s) => ({ topic: s.topic, guidance: s.guidance })),
    memory,
    recentConversations,
    recentQuestionTopics: questionTopics,
    list,
  };
}
