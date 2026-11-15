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
import { householdCaregivers } from "./access";

const EVENT_WINDOW_DAYS = 7;
const RECENT_CONVERSATIONS = 5;
const TOPIC_LOOKBACK_MS = 7 * DAY_MS;
const MAX_RECENT_TOPICS = 30;

export interface MessageView {
  from: string;
  body: string | null;
  hasPhoto: boolean;
  sentAt: number;
  seen: boolean;
}

export interface AgentContext {
  household: {
    id: Id<"households">;
    seniorPreferredName: string;
    timezone: string;
    localNow: string;
    weatherLocation: string | null;
  };
  caregivers: Array<{ name: string }>;
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
  recentQuestionTopics: string[];
  list: { openCount: number; items: string[] };
}

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

async function lifeProfile(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<AgentContext["lifeProfile"]> {
  const rows = await entriesInOrder(ctx, householdId);
  return rows.map((r) => ({ category: r.category, name: r.name, details: r.details ?? null }));
}

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

export async function buildAgentContext(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AgentContext> {
  const id = household._id;
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
    todayInstances(ctx, id, now, null),
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
    caregivers: caregivers.map((m) => ({ name: m.displayName })),
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
