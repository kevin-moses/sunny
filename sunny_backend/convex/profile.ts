import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  actorUserId,
  loadHousehold,
  memberNames,
  requireCaregiverReader,
  requireEditor,
} from "./lib/access";
import type { Actor } from "./lib/access";
import { audit } from "./lib/audit";
import { appError } from "./lib/errors";
import { MAX_FACT, MAX_VERIFIED_FACTS } from "./lib/memoryLimits";
import {
  entriesInOrder,
  factCandidates,
  factsInAgentOrder,
  findFactDuplicate,
  newestUnverified,
  verifiedFacts,
} from "./lib/profileReads";
import { cleanOptional, oneLine, requireMaxLength, requireNonBlank, textKey } from "./lib/text";
import { localDate, localTime } from "./lib/time";
import { lifeCategory } from "./lib/validators";

export const MAX_NAME = 120;
export const MAX_DETAILS = 600;
export const MAX_TOPIC = 200;
export const MAX_GUIDANCE = 1500;
export const MAX_MESSAGE = 1000;
export const MAX_ENTRIES = 150;
export const MAX_TOPICS = 30;
export const UNVERIFIED_SHOWN = 50;
export const OLDER_COUNT_LIMIT = 500;
export { DUPLICATE_SCAN, MAX_FACT, MAX_VERIFIED_FACTS } from "./lib/memoryLimits";
const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 100;

type ProfileTable = "lifeProfileEntries" | "sensitiveTopics" | "agentMemory";

export type LifeCategory = Infer<typeof lifeCategory>;

export interface EntryView {
  id: Id<"lifeProfileEntries">;
  category: LifeCategory;
  name: string;
  details: string | null;
}

export interface TopicView {
  id: Id<"sensitiveTopics">;
  topic: string;
  guidance: string;
}

export interface FactView {
  id: Id<"agentMemory">;
  fact: string;
  source: "caregiver" | "senior";
  verified: boolean;
  verifiedByName: string | null;
  notedOn: string;
  verifiedOn: string | null;
}

export interface MemoryView {
  facts: FactView[];
  olderUnverified: number;
}

export interface MessageView {
  id: Id<"familyMessages">;
  senderKind: "caregiver" | "senior";
  mine: boolean;
  senderName: string;
  body: string | null;
  hasPhoto: boolean;
  hasAudio: boolean;
  sentAt: number;
  sentDate: string;
  sentTime: string;
  seenAt: number | null;
}

export interface AddResult<T extends ProfileTable> {
  id: Id<T>;
  created: boolean;
  same: boolean;
  confirmed: boolean;
}

export interface AddOutcome<T extends ProfileTable> extends AddResult<T> {
  row: Doc<T>;
}

function addResult<T extends ProfileTable>(outcome: AddOutcome<T>): AddResult<T> {
  const { id, created, same, confirmed } = outcome;
  return { id, created, same, confirmed };
}

export interface EntryFields {
  category: LifeCategory;
  name: string;
  details?: string;
}

export interface EntryChanges {
  category?: LifeCategory;
  name?: string;
  details?: string | null;
}

export interface TopicChanges {
  topic?: string;
  guidance?: string;
}

export interface MemoryRows {
  facts: Doc<"agentMemory">[];
  olderUnverified: number;
}

function singleLine(value: string, max: number, label: string): string {
  return requireMaxLength(oneLine(requireNonBlank(value, label)), max, label);
}

function optionalLine(
  value: string | null | undefined,
  max: number,
  label: string,
): string | undefined {
  return cleanOptional(
    value === null || value === undefined ? undefined : oneLine(value),
    max,
    label,
  );
}

async function loadOwned<T extends ProfileTable>(
  ctx: QueryCtx,
  householdId: Id<"households">,
  id: Id<T>,
  label: string,
): Promise<Doc<T>> {
  const row = await ctx.db.get(id);
  if (!row || row.householdId !== householdId) throw appError("not_found", `${label} not found`);
  return row;
}

function rejectDuplicate<K>(
  rows: (K & { _id: string })[],
  key: (row: K) => string,
  next: NoInfer<K>,
  selfId: string,
  message: string,
): void {
  const wanted = key(next);
  if (rows.some((r) => r._id !== selfId && key(r) === wanted)) throw appError("invalid", message);
}

async function record(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  action: string,
  entity: string,
  entityId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await audit(ctx, { householdId, actor, action, entity, entityId, detail });
}

async function removeRow(
  ctx: MutationCtx,
  actor: Actor,
  row: Doc<ProfileTable>,
  entity: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await ctx.db.delete(row._id);
  await record(ctx, actor, row.householdId, "delete", entity, row._id, detail);
}

function entryKey(row: Pick<Doc<"lifeProfileEntries">, "category" | "name">): string {
  return `${row.category}:${textKey(row.name)}`;
}

function entryDetail(
  entry: Pick<Doc<"lifeProfileEntries">, "category" | "name" | "details">,
): Record<string, unknown> {
  return { category: entry.category, name: entry.name, details: entry.details ?? null };
}

export const listEntries = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<EntryView[]> => {
    await requireCaregiverReader(ctx, args.householdId);
    const rows = await entriesInOrder(ctx, args.householdId);
    return rows.map((r) => ({
      id: r._id,
      category: r.category,
      name: r.name,
      details: r.details ?? null,
    }));
  },
});

export async function addEntryCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  args: EntryFields,
): Promise<AddOutcome<"lifeProfileEntries">> {
  const name = singleLine(args.name, MAX_NAME, "Name");
  const details = optionalLine(args.details, MAX_DETAILS, "Details");
  const rows = await entriesInOrder(ctx, householdId);
  const wanted = entryKey({ category: args.category, name });
  const existing = rows.find((r) => entryKey(r) === wanted);
  if (existing) {
    const same =
      existing.name === name && (args.details === undefined || existing.details === details);
    return { id: existing._id, created: false, same, confirmed: false, row: existing };
  }
  if (rows.length >= MAX_ENTRIES) {
    throw appError("limit", `The life profile holds at most ${MAX_ENTRIES} entries`);
  }
  const entry = { category: args.category, name, details };
  const id = await ctx.db.insert("lifeProfileEntries", {
    householdId,
    ...entry,
    createdBy: actorUserId(actor),
  });
  await record(ctx, actor, householdId, "insert", "lifeProfileEntry", id, entryDetail(entry));
  const row = await loadOwned(ctx, householdId, id, "Entry");
  return { id, created: true, same: true, confirmed: false, row };
}

export const addEntry = mutation({
  args: {
    householdId: v.id("households"),
    category: lifeCategory,
    name: v.string(),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AddResult<"lifeProfileEntries">> => {
    const { householdId, ...fields } = args;
    const actor = await requireEditor(ctx, householdId);
    return addResult(await addEntryCore(ctx, actor, householdId, fields));
  },
});

export async function updateEntryCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  entryId: Id<"lifeProfileEntries">,
  changes: EntryChanges,
): Promise<Doc<"lifeProfileEntries">> {
  const entry = await loadOwned(ctx, householdId, entryId, "Entry");
  const next = {
    category: changes.category ?? entry.category,
    name: changes.name === undefined ? entry.name : singleLine(changes.name, MAX_NAME, "Name"),
    details:
      changes.details === undefined
        ? entry.details
        : optionalLine(changes.details, MAX_DETAILS, "Details"),
  };
  if (
    next.category === entry.category &&
    next.name === entry.name &&
    next.details === entry.details
  ) {
    return entry;
  }
  rejectDuplicate(
    await entriesInOrder(ctx, householdId),
    entryKey,
    next,
    entry._id,
    "Another entry already has that name",
  );
  await ctx.db.patch(entry._id, next);
  await record(ctx, actor, householdId, "update", "lifeProfileEntry", entry._id, {
    ...entryDetail(next),
    previous: entryDetail(entry),
  });
  return { ...entry, ...next };
}

export const updateEntry = mutation({
  args: {
    householdId: v.id("households"),
    entryId: v.id("lifeProfileEntries"),
    category: v.optional(lifeCategory),
    name: v.optional(v.string()),
    details: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<null> => {
    const { householdId, entryId, ...changes } = args;
    const actor = await requireEditor(ctx, householdId);
    await updateEntryCore(ctx, actor, householdId, entryId, changes);
    return null;
  },
});

export async function removeEntryCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  entryId: Id<"lifeProfileEntries">,
): Promise<Doc<"lifeProfileEntries">> {
  const entry = await loadOwned(ctx, householdId, entryId, "Entry");
  await removeRow(ctx, actor, entry, "lifeProfileEntry", entryDetail(entry));
  return entry;
}

export const removeEntry = mutation({
  args: { householdId: v.id("households"), entryId: v.id("lifeProfileEntries") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    await removeEntryCore(ctx, actor, args.householdId, args.entryId);
    return null;
  },
});

function topicKey(row: Pick<Doc<"sensitiveTopics">, "topic">): string {
  return textKey(row.topic);
}

export async function listTopicsCore(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"sensitiveTopics">[]> {
  return await ctx.db
    .query("sensitiveTopics")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
}

export const listTopics = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<TopicView[]> => {
    await requireCaregiverReader(ctx, args.householdId);
    const rows = await listTopicsCore(ctx, args.householdId);
    return rows.map((r) => ({ id: r._id, topic: r.topic, guidance: r.guidance }));
  },
});

export async function addTopicCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  args: { topic: string; guidance: string },
): Promise<AddOutcome<"sensitiveTopics">> {
  const topic = singleLine(args.topic, MAX_TOPIC, "Topic");
  const guidance = singleLine(args.guidance, MAX_GUIDANCE, "Guidance");
  const rows = await listTopicsCore(ctx, householdId);
  const wanted = topicKey({ topic });
  const existing = rows.find((r) => topicKey(r) === wanted);
  if (existing) {
    const same = existing.topic === topic && existing.guidance === guidance;
    return { id: existing._id, created: false, same, confirmed: false, row: existing };
  }
  if (rows.length >= MAX_TOPICS) {
    throw appError("limit", `The playbook holds at most ${MAX_TOPICS} topics`);
  }
  const id = await ctx.db.insert("sensitiveTopics", {
    householdId,
    topic,
    guidance,
    createdBy: actorUserId(actor),
  });
  await record(ctx, actor, householdId, "insert", "sensitiveTopic", id, { topic });
  const row = await loadOwned(ctx, householdId, id, "Topic");
  return { id, created: true, same: true, confirmed: false, row };
}

export const addTopic = mutation({
  args: { householdId: v.id("households"), topic: v.string(), guidance: v.string() },
  handler: async (ctx, args): Promise<AddResult<"sensitiveTopics">> => {
    const { householdId, ...fields } = args;
    const actor = await requireEditor(ctx, householdId);
    return addResult(await addTopicCore(ctx, actor, householdId, fields));
  },
});

export async function updateTopicCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  topicId: Id<"sensitiveTopics">,
  changes: TopicChanges,
): Promise<Doc<"sensitiveTopics">> {
  const row = await loadOwned(ctx, householdId, topicId, "Topic");
  const next = {
    topic: changes.topic === undefined ? row.topic : singleLine(changes.topic, MAX_TOPIC, "Topic"),
    guidance:
      changes.guidance === undefined
        ? row.guidance
        : singleLine(changes.guidance, MAX_GUIDANCE, "Guidance"),
  };
  if (next.topic === row.topic && next.guidance === row.guidance) return row;
  rejectDuplicate(
    await listTopicsCore(ctx, householdId),
    topicKey,
    next,
    row._id,
    "Another topic already has that wording",
  );
  await ctx.db.patch(row._id, next);
  await record(ctx, actor, householdId, "update", "sensitiveTopic", row._id, {
    topic: next.topic,
    previous: { topic: row.topic, guidance: row.guidance },
  });
  return { ...row, ...next };
}

export const updateTopic = mutation({
  args: {
    householdId: v.id("households"),
    topicId: v.id("sensitiveTopics"),
    topic: v.optional(v.string()),
    guidance: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const { householdId, topicId, ...changes } = args;
    const actor = await requireEditor(ctx, householdId);
    await updateTopicCore(ctx, actor, householdId, topicId, changes);
    return null;
  },
});

export async function removeTopicCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  topicId: Id<"sensitiveTopics">,
): Promise<Doc<"sensitiveTopics">> {
  const row = await loadOwned(ctx, householdId, topicId, "Topic");
  await removeRow(ctx, actor, row, "sensitiveTopic", { topic: row.topic });
  return row;
}

export const removeTopic = mutation({
  args: { householdId: v.id("households"), topicId: v.id("sensitiveTopics") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    await removeTopicCore(ctx, actor, args.householdId, args.topicId);
    return null;
  },
});

function requireVerifiedRoom(verified: Doc<"agentMemory">[]): void {
  if (verified.length >= MAX_VERIFIED_FACTS) {
    throw appError(
      "limit",
      `Sunny keeps at most ${MAX_VERIFIED_FACTS} confirmed facts; remove one before adding another`,
    );
  }
}

async function markVerified(
  ctx: MutationCtx,
  actor: Actor,
  fact: Doc<"agentMemory">,
): Promise<Doc<"agentMemory">> {
  const patch = { verifiedBy: actorUserId(actor), verifiedAt: Date.now() };
  await ctx.db.patch(fact._id, patch);
  await record(ctx, actor, fact.householdId, "verify", "agentMemory", fact._id, {
    fact: fact.fact,
    source: fact.source,
  });
  return { ...fact, ...patch };
}

export async function listMemoryCore(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<MemoryRows> {
  const [verified, unverified] = await Promise.all([
    verifiedFacts(ctx, householdId),
    newestUnverified(ctx, householdId, UNVERIFIED_SHOWN + OLDER_COUNT_LIMIT),
  ]);
  return {
    facts: factsInAgentOrder(verified, unverified.slice(0, UNVERIFIED_SHOWN)),
    olderUnverified: Math.max(0, unverified.length - UNVERIFIED_SHOWN),
  };
}

export const listMemory = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<MemoryView> => {
    await requireCaregiverReader(ctx, args.householdId);
    const [{ timezone }, names, memory] = await Promise.all([
      loadHousehold(ctx, args.householdId),
      memberNames(ctx, args.householdId),
      listMemoryCore(ctx, args.householdId),
    ]);
    const view = (r: Doc<"agentMemory">): FactView => ({
      id: r._id,
      fact: r.fact,
      source: r.source,
      verified: r.verifiedAt !== undefined,
      verifiedByName: r.verifiedBy === undefined ? null : (names.get(r.verifiedBy) ?? null),
      notedOn: localDate(r._creationTime, timezone),
      verifiedOn: r.verifiedAt === undefined ? null : localDate(r.verifiedAt, timezone),
    });
    return { facts: memory.facts.map(view), olderUnverified: memory.olderUnverified };
  },
});

export async function addFactCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  text: string,
): Promise<AddOutcome<"agentMemory">> {
  const fact = singleLine(text, MAX_FACT, "Fact");
  const { verified, candidates } = await factCandidates(ctx, householdId);
  const existing = findFactDuplicate(candidates, fact, null);
  if (existing && existing.verifiedAt !== undefined) {
    return { id: existing._id, created: false, same: true, confirmed: false, row: existing };
  }
  requireVerifiedRoom(verified);
  if (existing) {
    const row = await markVerified(ctx, actor, existing);
    return { id: existing._id, created: false, same: true, confirmed: true, row };
  }
  const id = await ctx.db.insert("agentMemory", {
    householdId,
    fact,
    source: "caregiver",
    verifiedBy: actorUserId(actor),
    verifiedAt: Date.now(),
  });
  await record(ctx, actor, householdId, "insert", "agentMemory", id, {
    fact,
    source: "caregiver",
  });
  const row = await loadOwned(ctx, householdId, id, "Fact");
  return { id, created: true, same: true, confirmed: false, row };
}

export const addFact = mutation({
  args: { householdId: v.id("households"), fact: v.string() },
  handler: async (ctx, args): Promise<AddResult<"agentMemory">> => {
    const actor = await requireEditor(ctx, args.householdId);
    return addResult(await addFactCore(ctx, actor, args.householdId, args.fact));
  },
});

export async function verifyFactCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  factId: Id<"agentMemory">,
): Promise<Doc<"agentMemory">> {
  const fact = await loadOwned(ctx, householdId, factId, "Fact");
  if (fact.verifiedAt !== undefined) return fact;
  requireVerifiedRoom(await verifiedFacts(ctx, householdId));
  return await markVerified(ctx, actor, fact);
}

export const verifyFact = mutation({
  args: { householdId: v.id("households"), factId: v.id("agentMemory") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    await verifyFactCore(ctx, actor, args.householdId, args.factId);
    return null;
  },
});

export async function correctFactCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  factId: Id<"agentMemory">,
  text: string,
): Promise<Doc<"agentMemory">> {
  const row = await loadOwned(ctx, householdId, factId, "Fact");
  const fact = singleLine(text, MAX_FACT, "Fact");
  const verified = row.verifiedAt !== undefined;
  if (fact === row.fact && verified) return row;
  const { verified: verifiedRows, candidates } = await factCandidates(ctx, householdId);
  if (findFactDuplicate(candidates, fact, row._id)) {
    throw appError("invalid", "Sunny already knows that fact");
  }
  if (!verified) requireVerifiedRoom(verifiedRows);
  const patch = { fact, verifiedBy: actorUserId(actor), verifiedAt: Date.now() };
  await ctx.db.patch(row._id, patch);
  await record(ctx, actor, householdId, "correct", "agentMemory", row._id, {
    fact,
    previous: row.fact,
    source: row.source,
  });
  return { ...row, ...patch };
}

export const correctFact = mutation({
  args: { householdId: v.id("households"), factId: v.id("agentMemory"), fact: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    await correctFactCore(ctx, actor, args.householdId, args.factId, args.fact);
    return null;
  },
});

export async function removeFactCore(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  factId: Id<"agentMemory">,
): Promise<Doc<"agentMemory">> {
  const row = await loadOwned(ctx, householdId, factId, "Fact");
  await removeRow(ctx, actor, row, "agentMemory", { fact: row.fact, source: row.source });
  return row;
}

export const removeFact = mutation({
  args: { householdId: v.id("households"), factId: v.id("agentMemory") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    await removeFactCore(ctx, actor, args.householdId, args.factId);
    return null;
  },
});

export const listMessages = query({
  args: { householdId: v.id("households"), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MessageView[]> => {
    const caller = await requireCaregiverReader(ctx, args.householdId);
    const limit = args.limit ?? DEFAULT_MESSAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_LIMIT) {
      throw appError("invalid", `Limit must be a whole number from 1 to ${MAX_MESSAGE_LIMIT}`);
    }
    const [household, names, rows] = await Promise.all([
      loadHousehold(ctx, args.householdId),
      memberNames(ctx, args.householdId),
      ctx.db
        .query("familyMessages")
        .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
        .order("desc")
        .take(limit),
    ]);
    return rows.map((m) => ({
      id: m._id,
      senderKind: m.senderKind,
      mine: m.senderKind === "caregiver" && m.senderUserId === caller.userId,
      senderName:
        m.senderKind === "senior"
          ? household.seniorPreferredName
          : (names.get(m.senderUserId ?? "") ?? "Family"),
      body: m.body ?? null,
      hasPhoto: m.photoStorageId !== undefined,
      hasAudio: m.audioStorageId !== undefined,
      sentAt: m._creationTime,
      sentDate: localDate(m._creationTime, household.timezone),
      sentTime: localTime(m._creationTime, household.timezone),
      seenAt: m.seenAt ?? null,
    }));
  },
});

export const sendMessage = mutation({
  args: { householdId: v.id("households"), body: v.string() },
  handler: async (ctx, args): Promise<Id<"familyMessages">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const body = requireMaxLength(requireNonBlank(args.body, "Message"), MAX_MESSAGE, "Message");
    const id = await ctx.db.insert("familyMessages", {
      householdId: args.householdId,
      senderKind: "caregiver",
      senderUserId: actor.userId,
      body,
    });
    await record(ctx, actor, args.householdId, "insert", "familyMessage", id, {
      length: body.length,
    });
    return id;
  },
});
