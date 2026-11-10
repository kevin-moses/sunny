// convex/profile.ts
// Purpose: The caregiver write path for what the voice agent knows about the senior's life:
// life profile entries (people, places, doctors, habits, interests, preferences), the
// sensitive-topic playbook (how to answer hard questions), agent memory (facts, each with a
// source and a verified state) and family messages. agent.getContext reads all four tables
// into the voice agent's context; this module is the only place caregivers change them.
//
// Access: every list is caregiver only (requireCaregiverReader: any role, never a paired device),
// because what it holds is written about the senior (a spouse's death, guidance for hard
// questions) and nothing on the senior's screens uses it. Every write uses requireEditor
// (primary and member caregivers; viewers and devices cannot write) and records an auditLog row.
//
// Text: every field is trimmed and capped server-side. Names, topics, facts, details and guidance
// are single paragraphs (inner whitespace, line breaks included, collapsed to one space: the
// voice prompt flattens them anyway, and the app's Return key means "done"); message bodies keep
// their line breaks. Counts are capped too, because getContext loads every life profile entry
// and every topic into each conversation, and loads at most 50 memory facts (verified first,
// then newest; MEMORY_LIMIT in agent.ts). MAX_VERIFIED_FACTS is 40, so at least 10 places of
// that window are left for things the senior said.
//
// Duplicates: adding an entry whose category and name, a topic whose wording, or a fact whose
// text already exists (compared case-insensitively, whitespace collapsed) inserts nothing and
// returns the existing row with created = false and same = whether the stored text equals what
// was sent (an entry's name and details, a topic's wording and guidance; facts match on their
// text, so same is always true). Nothing is changed when it differs: the caller decides whether
// to update it (the app says it is already listed; the bulk loader's --update uses the update
// mutations). Adding a fact that matches an unverified senior-stated fact verifies that fact
// (confirmed = true). Renaming onto an existing key is rejected.
//
// Memory reads are bounded: verified facts are read through the by_household_verified index
// (at most VERIFIED_READ_LIMIT), the newest unverified ones the same way, and the duplicate check
// for a fact looks at the verified facts plus the newest DUPLICATE_SCAN unverified ones (a senior
// fact older than that is not detected as a duplicate).
//
// Memory rule (SPEC "Memory hygiene"): things the senior says never overwrite caregiver-verified
// facts. Senior facts are inserted unverified by the voice agent (agent tools, not here); only
// an editor caregiver can verify a fact (verifyFact keeps the first verifier), correct its text
// (correctFact, which also verifies it, keeping its source) or remove it.
//
// Messages: sendMessage stores a caregiver's text message to the senior (no photo or audio in
// this pass); listMessages returns the newest messages, including those the senior sent through
// the voice agent, with seen state, and says which are the caller's own (no member ids).
//
// Views: list results use null for absent optional values, and carry household-local dates and
// times ("YYYY-MM-DD", "HH:MM") so clients do no timezone conversion.
//
// Functions: listEntries, addEntry, updateEntry, removeEntry; listTopics, addTopic, updateTopic,
// removeTopic; listMemory, addFact, verifyFact, correctFact, removeFact; listMessages,
// sendMessage.
//
// Last modified: 2026-11-09

import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { loadHousehold, memberNames, requireCaregiverReader, requireEditor } from "./lib/access";
import type { CaregiverActor } from "./lib/access";
import { audit } from "./lib/audit";
import { appError } from "./lib/errors";
import { requireMaxLength, requireNonBlank } from "./lib/text";
import { localDate, localTime } from "./lib/time";
import { lifeCategory } from "./lib/validators";

/** Longest name of a life profile entry. */
export const MAX_NAME = 120;
/** Longest details of a life profile entry. */
export const MAX_DETAILS = 600;
/** Longest sensitive topic wording. */
export const MAX_TOPIC = 200;
/** Longest guidance for a sensitive topic. */
export const MAX_GUIDANCE = 1500;
/** Longest memory fact. */
export const MAX_FACT = 300;
/** Longest family message body. */
export const MAX_MESSAGE = 1000;
/** Most life profile entries a household may have (all are in every conversation). */
export const MAX_ENTRIES = 150;
/** Most sensitive topics a household may have (all are in every conversation). */
export const MAX_TOPICS = 30;
/** Most verified facts: 40 of the agent's 50-fact window, leaving 10 for the senior's own. */
export const MAX_VERIFIED_FACTS = 40;
/** Unverified facts listMemory returns (newest first); older ones are only counted. */
export const UNVERIFIED_SHOWN = 50;
/** listMemory counts older unverified facts up to this many. */
export const OLDER_COUNT_LIMIT = 500;
/** Newest unverified facts the duplicate check of a fact looks at. */
export const DUPLICATE_SCAN = 500;
/** Most verified facts any read loads (more than the cap, for rows written before it). */
const VERIFIED_READ_LIMIT = 200;
/** Messages listMessages returns by default, and at most. */
const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 100;

/** Category order of the lifeCategory validator, which agent.getContext also sorts by. */
const CATEGORY_ORDER = lifeCategory.members.map((m) => m.value as string);

/** A life profile category. */
export type LifeCategory = Infer<typeof lifeCategory>;

/** One life profile entry as the caregiver app shows it. */
export interface EntryView {
  id: Id<"lifeProfileEntries">;
  category: LifeCategory;
  name: string;
  details: string | null;
}

/** One sensitive topic as the caregiver app shows it. */
export interface TopicView {
  id: Id<"sensitiveTopics">;
  topic: string;
  guidance: string;
}

/** One memory fact as the caregiver app shows it. */
export interface FactView {
  id: Id<"agentMemory">;
  fact: string;
  source: "caregiver" | "senior";
  verified: boolean;
  /** Display name of the caregiver who verified it; null when unverified or no longer a member. */
  verifiedByName: string | null;
  /** Household-local date the fact was noted, "YYYY-MM-DD". */
  notedOn: string;
  /** Household-local date it was verified; null when unverified. */
  verifiedOn: string | null;
}

/** What listMemory returns. */
export interface MemoryView {
  /** Verified facts (newest first), then the newest UNVERIFIED_SHOWN unverified ones. */
  facts: FactView[];
  /** How many older unverified facts are not in facts, counted up to OLDER_COUNT_LIMIT. */
  olderUnverified: number;
}

/** One family message as the caregiver app shows it. */
export interface MessageView {
  id: Id<"familyMessages">;
  senderKind: "caregiver" | "senior";
  /** Whether the signed-in caregiver sent it. */
  mine: boolean;
  /** The caregiver's display name or the senior's preferred name; "Family" for a former member. */
  senderName: string;
  body: string | null;
  hasPhoto: boolean;
  hasAudio: boolean;
  /** Epoch ms. */
  sentAt: number;
  /** Household-local date and time sent, "YYYY-MM-DD" and "HH:MM". */
  sentDate: string;
  sentTime: string;
  /** Epoch ms the senior saw it (caregiver messages), or null. */
  seenAt: number | null;
}

/** What an add returns. */
export interface AddResult<T extends "lifeProfileEntries" | "sensitiveTopics" | "agentMemory"> {
  /** The new row, or the existing one with the same key. */
  id: Id<T>;
  /** True when a row was inserted. */
  created: boolean;
  /** True when the stored text equals what was sent (always true when created). */
  same: boolean;
  /** True when the add verified an existing unverified fact (addFact only). */
  confirmed: boolean;
}

/**
 * purpose: Clean a single-paragraph text field: trim, collapse all whitespace (line breaks
 *          included) to one space, require text, cap.
 * @param value: (string) Raw text.
 * @param max: (number) Maximum length after cleaning.
 * @param label: (string) Field name for the error message.
 * @return: (string) The cleaned text.
 * @raises invalid when blank or too long.
 */
function singleLine(value: string, max: number, label: string): string {
  return requireMaxLength(requireNonBlank(value, label).replace(/\s+/g, " "), max, label);
}

/**
 * purpose: Clean an optional single-paragraph field: blank becomes absent.
 * @param value: (string | null | undefined) Raw text.
 * @param max: (number) Maximum length after cleaning.
 * @param label: (string) Field name for the error message.
 * @return: (string | undefined) The cleaned text, or undefined when blank or absent.
 * @raises invalid when too long.
 */
function optionalLine(
  value: string | null | undefined,
  max: number,
  label: string,
): string | undefined {
  return (value ?? "").trim() === "" ? undefined : singleLine(value!, max, label);
}

/**
 * purpose: The comparison key of a name, topic or fact: trimmed, whitespace collapsed, lower case.
 * @param value: (string) Text.
 * @return: (string) The key.
 */
function textKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * purpose: Load a row of one of this module's tables and check it belongs to the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household the caller acts in.
 * @param id: (Id<T>) Row id.
 * @param label: (string) What the row is, for the not-found message.
 * @return: (Promise<Doc<T>>) The row.
 * @raises not_found when it does not exist or belongs to another household.
 */
async function loadOwned<T extends "lifeProfileEntries" | "sensitiveTopics" | "agentMemory">(
  ctx: QueryCtx,
  householdId: Id<"households">,
  id: Id<T>,
  label: string,
): Promise<Doc<T>> {
  const row = (await ctx.db.get(id)) as Doc<T> | null;
  if (!row || row.householdId !== householdId) throw appError("not_found", `${label} not found`);
  return row;
}

/**
 * purpose: Reject a change when another row already has the same key.
 * @param rows: (Array<{ _id: string }>) The rows to compare with.
 * @param key: ((row) => string) The key of a row.
 * @param wanted: (string) The key the changed row would have.
 * @param selfId: (string) The changed row, which may keep its own key.
 * @param message: (string) Error message.
 * @return: (void)
 * @raises invalid when another row has that key.
 */
function rejectDuplicate<R extends { _id: string }>(
  rows: R[],
  key: (row: R) => string,
  wanted: string,
  selfId: string,
  message: string,
): void {
  if (rows.some((r) => r._id !== selfId && key(r) === wanted)) throw appError("invalid", message);
}

/**
 * purpose: The result of an add that found an existing row.
 * @param id: (Id<T>) The existing row.
 * @param same: (boolean) Whether its stored text equals what was sent.
 * @param confirmed: (boolean) Whether the add verified it.
 * @return: (AddResult<T>) The result.
 */
function existingResult<T extends "lifeProfileEntries" | "sensitiveTopics" | "agentMemory">(
  id: Id<T>,
  same: boolean,
  confirmed = false,
): AddResult<T> {
  return { id, created: false, same, confirmed };
}

/**
 * purpose: The result of an add that inserted a row.
 * @param id: (Id<T>) The new row.
 * @return: (AddResult<T>) The result.
 */
function createdResult<T extends "lifeProfileEntries" | "sensitiveTopics" | "agentMemory">(
  id: Id<T>,
): AddResult<T> {
  return { id, created: true, same: true, confirmed: false };
}

// ---------------------------------------------------------------------------------------------
// Life profile entries
// ---------------------------------------------------------------------------------------------

/**
 * purpose: Every life profile entry of a household (at most MAX_ENTRIES, kept by addEntry).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"lifeProfileEntries">[]>) The rows, in creation order.
 */
async function entryRows(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"lifeProfileEntries">[]> {
  return await ctx.db
    .query("lifeProfileEntries")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
}

/**
 * purpose: The duplicate key of an entry: its category and its name's text key.
 * @param row: (Pick<Doc<"lifeProfileEntries">, "category" | "name">) The entry.
 * @return: (string) The key.
 */
function entryKey(row: Pick<Doc<"lifeProfileEntries">, "category" | "name">): string {
  return `${row.category}:${textKey(row.name)}`;
}

/**
 * purpose: Record an audit row for a life profile entry.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (CaregiverActor) Who changed it.
 * @param action: (string) "insert", "update" or "delete".
 * @param entry: (Pick<Doc<"lifeProfileEntries">, ...>) The entry after the change (before, for a delete).
 * @return: (Promise<void>) Resolves when written.
 */
async function auditEntry(
  ctx: MutationCtx,
  actor: CaregiverActor,
  action: string,
  entry: Pick<Doc<"lifeProfileEntries">, "_id" | "category" | "name">,
): Promise<void> {
  await audit(ctx, {
    householdId: actor.householdId,
    actor,
    action,
    entity: "lifeProfileEntry",
    entityId: entry._id,
    detail: { category: entry.category, name: entry.name },
  });
}

/**
 * purpose: The household's life profile: by category (the lifeCategory order: person, place,
 *          doctor, habit, interest, preference, other, as the agent groups it), then by name,
 *          case-insensitively. Caregivers of any role only.
 * @param householdId: (Id<"households">) Household.
 * @return: (EntryView[]) The entries.
 * @raises forbidden for a paired device or a non-member.
 */
export const listEntries = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<EntryView[]> => {
    await requireCaregiverReader(ctx, args.householdId);
    const rows = await entryRows(ctx, args.householdId);
    rows.sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
    return rows.map((r) => ({
      id: r._id,
      category: r.category,
      name: r.name,
      details: r.details ?? null,
    }));
  },
});

/**
 * purpose: Add a life profile entry. Editors only. When an entry with the same category and
 *          name exists, nothing changes and that entry is returned with created = false and
 *          same = whether its name and details equal what was sent.
 * @param householdId: (Id<"households">) Household.
 * @param category: (LifeCategory) person, place, doctor, habit, interest, preference or other.
 * @param name: (string) Who or what, for example "Sarah"; at most 120 characters.
 * @param details: (string, optional) For example "Daughter, lives in Boston"; at most 600.
 * @return: (AddResult<"lifeProfileEntries">) The entry, created, same and confirmed (false).
 * @raises invalid for blank or too long text; limit when the household has 150 entries.
 */
export const addEntry = mutation({
  args: {
    householdId: v.id("households"),
    category: lifeCategory,
    name: v.string(),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AddResult<"lifeProfileEntries">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const name = singleLine(args.name, MAX_NAME, "Name");
    const details = optionalLine(args.details, MAX_DETAILS, "Details");
    const rows = await entryRows(ctx, args.householdId);
    const key = entryKey({ category: args.category, name });
    const existing = rows.find((r) => entryKey(r) === key);
    if (existing) {
      return existingResult(existing._id, existing.name === name && existing.details === details);
    }
    if (rows.length >= MAX_ENTRIES) {
      throw appError("limit", `The life profile holds at most ${MAX_ENTRIES} entries`);
    }
    const id = await ctx.db.insert("lifeProfileEntries", {
      householdId: args.householdId,
      category: args.category,
      name,
      details,
      createdBy: actor.userId,
    });
    await auditEntry(ctx, actor, "insert", { _id: id, category: args.category, name });
    return createdResult(id);
  },
});

/**
 * purpose: Change a life profile entry; fields left out are unchanged and details = null (or
 *          blank) clears the details. Editors only. A change that leaves every field as it was
 *          writes nothing.
 * @param householdId: (Id<"households">) Household.
 * @param entryId: (Id<"lifeProfileEntries">) Entry to change.
 * @param category: (LifeCategory, optional) New category.
 * @param name: (string, optional) New name.
 * @param details: (string | null, optional) New details; null or blank clears them.
 * @return: (null)
 * @raises not_found for another household's entry; invalid for bad text or when another entry
 *         already has that category and name.
 */
export const updateEntry = mutation({
  args: {
    householdId: v.id("households"),
    entryId: v.id("lifeProfileEntries"),
    category: v.optional(lifeCategory),
    name: v.optional(v.string()),
    details: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const entry = await loadOwned(ctx, args.householdId, args.entryId, "Entry");
    const next = {
      category: args.category ?? entry.category,
      name: args.name === undefined ? entry.name : singleLine(args.name, MAX_NAME, "Name"),
      details:
        args.details === undefined
          ? entry.details
          : optionalLine(args.details, MAX_DETAILS, "Details"),
    };
    if (
      next.category === entry.category &&
      next.name === entry.name &&
      next.details === entry.details
    ) {
      return null;
    }
    rejectDuplicate(
      await entryRows(ctx, args.householdId),
      entryKey,
      entryKey(next),
      entry._id,
      "Another entry already has that name",
    );
    await ctx.db.patch(entry._id, next);
    await auditEntry(ctx, actor, "update", { _id: entry._id, ...next });
    return null;
  },
});

/**
 * purpose: Delete a life profile entry. Editors only.
 * @param householdId: (Id<"households">) Household.
 * @param entryId: (Id<"lifeProfileEntries">) Entry to delete.
 * @return: (null)
 * @raises not_found for another household's entry.
 */
export const removeEntry = mutation({
  args: { householdId: v.id("households"), entryId: v.id("lifeProfileEntries") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const entry = await loadOwned(ctx, args.householdId, args.entryId, "Entry");
    await ctx.db.delete(entry._id);
    await auditEntry(ctx, actor, "delete", entry);
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Sensitive topics
// ---------------------------------------------------------------------------------------------

/**
 * purpose: Every sensitive topic of a household (at most MAX_TOPICS, kept by addTopic).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"sensitiveTopics">[]>) The rows, in creation order (the agent's order).
 */
async function topicRows(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"sensitiveTopics">[]> {
  return await ctx.db
    .query("sensitiveTopics")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
}

/**
 * purpose: The duplicate key of a topic: its wording's text key.
 * @param row: (Pick<Doc<"sensitiveTopics">, "topic">) The topic.
 * @return: (string) The key.
 */
function topicKey(row: Pick<Doc<"sensitiveTopics">, "topic">): string {
  return textKey(row.topic);
}

/**
 * purpose: Record an audit row for a sensitive topic.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (CaregiverActor) Who changed it.
 * @param action: (string) "insert", "update" or "delete".
 * @param topic: (Pick<Doc<"sensitiveTopics">, "_id" | "topic">) The topic.
 * @return: (Promise<void>) Resolves when written.
 */
async function auditTopic(
  ctx: MutationCtx,
  actor: CaregiverActor,
  action: string,
  topic: Pick<Doc<"sensitiveTopics">, "_id" | "topic">,
): Promise<void> {
  await audit(ctx, {
    householdId: actor.householdId,
    actor,
    action,
    entity: "sensitiveTopic",
    entityId: topic._id,
    detail: { topic: topic.topic },
  });
}

/**
 * purpose: The household's sensitive-topic playbook, in the order the agent reads it (creation
 *          order). Caregivers of any role only.
 * @param householdId: (Id<"households">) Household.
 * @return: (TopicView[]) The topics.
 * @raises forbidden for a paired device or a non-member.
 */
export const listTopics = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<TopicView[]> => {
    await requireCaregiverReader(ctx, args.householdId);
    const rows = await topicRows(ctx, args.householdId);
    return rows.map((r) => ({ id: r._id, topic: r.topic, guidance: r.guidance }));
  },
});

/**
 * purpose: Add a sensitive topic and how to handle it. Editors only. When a topic with the same
 *          wording exists, nothing changes and it is returned with created = false and same =
 *          whether its wording and guidance equal what was sent.
 * @param householdId: (Id<"households">) Household.
 * @param topic: (string) What the senior may ask about, for example "her husband Robert"; at
 *        most 200 characters. The agent reads it as "If asked about <topic>: <guidance>".
 * @param guidance: (string) How to answer; at most 1500 characters.
 * @return: (AddResult<"sensitiveTopics">) The topic, created, same and confirmed (false).
 * @raises invalid for blank or too long text; limit when the household has 30 topics.
 */
export const addTopic = mutation({
  args: { householdId: v.id("households"), topic: v.string(), guidance: v.string() },
  handler: async (ctx, args): Promise<AddResult<"sensitiveTopics">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const topic = singleLine(args.topic, MAX_TOPIC, "Topic");
    const guidance = singleLine(args.guidance, MAX_GUIDANCE, "Guidance");
    const rows = await topicRows(ctx, args.householdId);
    const existing = rows.find((r) => topicKey(r) === textKey(topic));
    if (existing) {
      return existingResult(
        existing._id,
        existing.topic === topic && existing.guidance === guidance,
      );
    }
    if (rows.length >= MAX_TOPICS) {
      throw appError("limit", `The playbook holds at most ${MAX_TOPICS} topics`);
    }
    const id = await ctx.db.insert("sensitiveTopics", {
      householdId: args.householdId,
      topic,
      guidance,
      createdBy: actor.userId,
    });
    await auditTopic(ctx, actor, "insert", { _id: id, topic });
    return createdResult(id);
  },
});

/**
 * purpose: Change a sensitive topic's wording or guidance; fields left out are unchanged.
 *          Editors only. A change that leaves both as they were writes nothing.
 * @param householdId: (Id<"households">) Household.
 * @param topicId: (Id<"sensitiveTopics">) Topic to change.
 * @param topic: (string, optional) New wording.
 * @param guidance: (string, optional) New guidance.
 * @return: (null)
 * @raises not_found for another household's topic; invalid for blank or too long text or when
 *         another topic already has that wording.
 */
export const updateTopic = mutation({
  args: {
    householdId: v.id("households"),
    topicId: v.id("sensitiveTopics"),
    topic: v.optional(v.string()),
    guidance: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const row = await loadOwned(ctx, args.householdId, args.topicId, "Topic");
    const next = {
      topic: args.topic === undefined ? row.topic : singleLine(args.topic, MAX_TOPIC, "Topic"),
      guidance:
        args.guidance === undefined
          ? row.guidance
          : singleLine(args.guidance, MAX_GUIDANCE, "Guidance"),
    };
    if (next.topic === row.topic && next.guidance === row.guidance) return null;
    rejectDuplicate(
      await topicRows(ctx, args.householdId),
      topicKey,
      textKey(next.topic),
      row._id,
      "Another topic already has that wording",
    );
    await ctx.db.patch(row._id, next);
    await auditTopic(ctx, actor, "update", { _id: row._id, topic: next.topic });
    return null;
  },
});

/**
 * purpose: Delete a sensitive topic. Editors only.
 * @param householdId: (Id<"households">) Household.
 * @param topicId: (Id<"sensitiveTopics">) Topic to delete.
 * @return: (null)
 * @raises not_found for another household's topic.
 */
export const removeTopic = mutation({
  args: { householdId: v.id("households"), topicId: v.id("sensitiveTopics") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const row = await loadOwned(ctx, args.householdId, args.topicId, "Topic");
    await ctx.db.delete(row._id);
    await auditTopic(ctx, actor, "delete", row);
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Agent memory
// ---------------------------------------------------------------------------------------------

/**
 * purpose: The household's verified facts, through the by_household_verified index.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"agentMemory">[]>) At most VERIFIED_READ_LIMIT rows, in verified order.
 */
async function verifiedFacts(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"agentMemory">[]> {
  return await ctx.db
    .query("agentMemory")
    .withIndex("by_household_verified", (q) => q.eq("householdId", householdId).gt("verifiedAt", 0))
    .take(VERIFIED_READ_LIMIT);
}

/**
 * purpose: The household's newest unverified facts, through the by_household_verified index.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param limit: (number) How many at most.
 * @return: (Promise<Doc<"agentMemory">[]>) The rows, newest first.
 */
async function newestUnverified(
  ctx: QueryCtx,
  householdId: Id<"households">,
  limit: number,
): Promise<Doc<"agentMemory">[]> {
  return await ctx.db
    .query("agentMemory")
    .withIndex("by_household_verified", (q) =>
      q.eq("householdId", householdId).eq("verifiedAt", undefined),
    )
    .order("desc")
    .take(limit);
}

/**
 * purpose: Find a fact with the same text key among the verified facts and the newest
 *          DUPLICATE_SCAN unverified ones.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param fact: (string) The cleaned fact text.
 * @param exceptId: (Id<"agentMemory"> | null) A fact to ignore (the one being corrected).
 * @return: (Promise<Doc<"agentMemory"> | null>) The duplicate, or null.
 */
async function findFactDuplicate(
  ctx: QueryCtx,
  householdId: Id<"households">,
  fact: string,
  exceptId: Id<"agentMemory"> | null,
): Promise<Doc<"agentMemory"> | null> {
  const key = textKey(fact);
  const candidates = [
    ...(await verifiedFacts(ctx, householdId)),
    ...(await newestUnverified(ctx, householdId, DUPLICATE_SCAN)),
  ];
  return candidates.find((r) => r._id !== exceptId && textKey(r.fact) === key) ?? null;
}

/**
 * purpose: Refuse to verify one more fact when the household already has MAX_VERIFIED_FACTS
 *          verified facts (more would crowd the senior's own facts out of the agent's window).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<void>) Resolves when there is room.
 * @raises limit when the cap is reached.
 */
async function requireVerifiedRoom(ctx: QueryCtx, householdId: Id<"households">): Promise<void> {
  if ((await verifiedFacts(ctx, householdId)).length >= MAX_VERIFIED_FACTS) {
    throw appError(
      "limit",
      `Sunny keeps at most ${MAX_VERIFIED_FACTS} confirmed facts; remove one before adding another`,
    );
  }
}

/**
 * purpose: Record an audit row for a memory fact.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (CaregiverActor) Who changed it.
 * @param action: (string) "insert", "verify", "correct" or "delete".
 * @param factId: (Id<"agentMemory">) The fact.
 * @param detail: (Record<string, unknown>) What to record (the fact text, and the previous
 *        text for a correction).
 * @return: (Promise<void>) Resolves when written.
 */
async function auditFact(
  ctx: MutationCtx,
  actor: CaregiverActor,
  action: string,
  factId: Id<"agentMemory">,
  detail: Record<string, unknown>,
): Promise<void> {
  await audit(ctx, {
    householdId: actor.householdId,
    actor,
    action,
    entity: "agentMemory",
    entityId: factId,
    detail,
  });
}

/**
 * purpose: Mark a fact verified by the caregiver, now.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (CaregiverActor) The verifying caregiver.
 * @param fact: (Doc<"agentMemory">) An unverified fact.
 * @return: (Promise<void>) Resolves when the fact is patched and audited.
 */
async function markVerified(
  ctx: MutationCtx,
  actor: CaregiverActor,
  fact: Doc<"agentMemory">,
): Promise<void> {
  await ctx.db.patch(fact._id, { verifiedBy: actor.userId, verifiedAt: Date.now() });
  await auditFact(ctx, actor, "verify", fact._id, { fact: fact.fact, source: fact.source });
}

/**
 * purpose: What the agent remembers, in the order getContext reads it: verified facts first
 *          (newest first), then the newest UNVERIFIED_SHOWN unverified facts, with a count of the
 *          older unverified ones. Caregivers of any role only.
 * @param householdId: (Id<"households">) Household.
 * @return: (MemoryView) The facts, with source, verified state and household-local dates, and
 *          olderUnverified (counted up to OLDER_COUNT_LIMIT).
 * @raises forbidden for a paired device or a non-member.
 */
export const listMemory = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<MemoryView> => {
    await requireCaregiverReader(ctx, args.householdId);
    const { timezone } = await loadHousehold(ctx, args.householdId);
    const names = await memberNames(ctx, args.householdId);
    const verified = await verifiedFacts(ctx, args.householdId);
    verified.sort((a, b) => b._creationTime - a._creationTime);
    const unverified = await newestUnverified(
      ctx,
      args.householdId,
      UNVERIFIED_SHOWN + OLDER_COUNT_LIMIT,
    );
    const view = (r: Doc<"agentMemory">): FactView => ({
      id: r._id,
      fact: r.fact,
      source: r.source,
      verified: r.verifiedAt !== undefined,
      verifiedByName: r.verifiedBy === undefined ? null : (names.get(r.verifiedBy) ?? null),
      notedOn: localDate(r._creationTime, timezone),
      verifiedOn: r.verifiedAt === undefined ? null : localDate(r.verifiedAt, timezone),
    });
    return {
      facts: [...verified, ...unverified.slice(0, UNVERIFIED_SHOWN)].map(view),
      olderUnverified: Math.max(0, unverified.length - UNVERIFIED_SHOWN),
    };
  },
});

/**
 * purpose: Add a fact a caregiver knows; it is verified at once (source caregiver). Editors
 *          only. When the same fact is stored (same text, ignoring case and spacing), nothing is
 *          added and that fact is returned with created = false and same = true; if it was an
 *          unverified senior-stated fact it is verified now (confirmed = true).
 * @param householdId: (Id<"households">) Household.
 * @param fact: (string) For example "Her cat is called Biscuit"; at most 300 characters.
 * @return: (AddResult<"agentMemory">) The fact, created, same and confirmed.
 * @raises invalid for blank or too long text; limit at 40 verified facts.
 */
export const addFact = mutation({
  args: { householdId: v.id("households"), fact: v.string() },
  handler: async (ctx, args): Promise<AddResult<"agentMemory">> => {
    const actor = await requireEditor(ctx, args.householdId);
    const fact = singleLine(args.fact, MAX_FACT, "Fact");
    const existing = await findFactDuplicate(ctx, args.householdId, fact, null);
    if (existing) {
      if (existing.verifiedAt !== undefined) return existingResult(existing._id, true);
      await requireVerifiedRoom(ctx, args.householdId);
      await markVerified(ctx, actor, existing);
      return existingResult(existing._id, true, true);
    }
    await requireVerifiedRoom(ctx, args.householdId);
    const id = await ctx.db.insert("agentMemory", {
      householdId: args.householdId,
      fact,
      source: "caregiver",
      verifiedBy: actor.userId,
      verifiedAt: Date.now(),
    });
    await auditFact(ctx, actor, "insert", id, { fact, source: "caregiver" });
    return createdResult(id);
  },
});

/**
 * purpose: Confirm a fact (typically one the senior said). Editors only. An already verified
 *          fact is left as it was, keeping its first verifier.
 * @param householdId: (Id<"households">) Household.
 * @param factId: (Id<"agentMemory">) Fact to verify.
 * @return: (null)
 * @raises not_found for another household's fact; limit at 40 verified facts.
 */
export const verifyFact = mutation({
  args: { householdId: v.id("households"), factId: v.id("agentMemory") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const fact = await loadOwned(ctx, args.householdId, args.factId, "Fact");
    if (fact.verifiedAt !== undefined) return null;
    await requireVerifiedRoom(ctx, args.householdId);
    await markVerified(ctx, actor, fact);
    return null;
  },
});

/**
 * purpose: Correct a fact's text. Editors only. A caregiver's correction verifies the fact
 *          under their name (its source is kept). Saving the same text verifies an unverified
 *          fact and leaves a verified one unchanged.
 * @param householdId: (Id<"households">) Household.
 * @param factId: (Id<"agentMemory">) Fact to correct.
 * @param fact: (string) The corrected text; at most 300 characters.
 * @return: (null)
 * @raises not_found for another household's fact; invalid for blank or too long text or when
 *         another fact already says the same; limit at 40 verified facts.
 */
export const correctFact = mutation({
  args: { householdId: v.id("households"), factId: v.id("agentMemory"), fact: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const row = await loadOwned(ctx, args.householdId, args.factId, "Fact");
    const fact = singleLine(args.fact, MAX_FACT, "Fact");
    const verified = row.verifiedAt !== undefined;
    if (fact === row.fact && verified) return null;
    if (await findFactDuplicate(ctx, args.householdId, fact, row._id)) {
      throw appError("invalid", "Sunny already knows that fact");
    }
    if (!verified) await requireVerifiedRoom(ctx, args.householdId);
    await ctx.db.patch(row._id, { fact, verifiedBy: actor.userId, verifiedAt: Date.now() });
    await auditFact(ctx, actor, "correct", row._id, {
      fact,
      previous: row.fact,
      source: row.source,
    });
    return null;
  },
});

/**
 * purpose: Delete a fact, verified or not. Editors only.
 * @param householdId: (Id<"households">) Household.
 * @param factId: (Id<"agentMemory">) Fact to delete.
 * @return: (null)
 * @raises not_found for another household's fact.
 */
export const removeFact = mutation({
  args: { householdId: v.id("households"), factId: v.id("agentMemory") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const row = await loadOwned(ctx, args.householdId, args.factId, "Fact");
    await ctx.db.delete(row._id);
    await auditFact(ctx, actor, "delete", row._id, { fact: row.fact, source: row.source });
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Family messages
// ---------------------------------------------------------------------------------------------

/**
 * purpose: The household's newest family messages, from caregivers and from the senior (sent
 *          through the voice agent), newest first, with who sent them (mine for the caller's
 *          own; no member ids are returned) and whether the senior has seen them. Caregivers of
 *          any role only.
 * @param householdId: (Id<"households">) Household.
 * @param limit: (number, optional) How many, 1 to 100; default 30.
 * @return: (MessageView[]) The messages, newest first.
 * @raises forbidden for a paired device or a non-member; invalid for a limit outside 1 to 100.
 */
export const listMessages = query({
  args: { householdId: v.id("households"), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<MessageView[]> => {
    const caller = await requireCaregiverReader(ctx, args.householdId);
    const limit = args.limit ?? DEFAULT_MESSAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_LIMIT) {
      throw appError("invalid", `Limit must be a whole number from 1 to ${MAX_MESSAGE_LIMIT}`);
    }
    const household = await loadHousehold(ctx, args.householdId);
    const names = await memberNames(ctx, args.householdId);
    const rows = await ctx.db
      .query("familyMessages")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .order("desc")
      .take(limit);
    return rows.map((m) => ({
      id: m._id,
      senderKind: m.senderKind,
      mine: m.senderKind === "caregiver" && m.senderUserId === caller.userId,
      senderName:
        m.senderKind === "senior"
          ? household.seniorPreferredName
          : ((m.senderUserId === undefined ? undefined : names.get(m.senderUserId)) ?? "Family"),
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

/**
 * purpose: Send the senior a text message from the signed-in caregiver. Editors only. The
 *          voice agent reads the newest caregiver message ("What did Sarah send?").
 * @param householdId: (Id<"households">) Household.
 * @param body: (string) The message; trimmed, 1 to 1000 characters, line breaks kept.
 * @return: (Id<"familyMessages">) The new message.
 * @raises invalid for blank or too long text.
 */
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
    await audit(ctx, {
      householdId: args.householdId,
      actor,
      action: "insert",
      entity: "familyMessage",
      entityId: id,
      detail: { length: body.length },
    });
    return id;
  },
});
