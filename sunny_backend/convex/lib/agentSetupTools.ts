// lib/agentSetupTools.ts
// Purpose: The household agent's setup tools, for caregivers who tell Sunny in the chat what it
// should know and how the household is set up (notes/SPEC.md "Knowledge" and "Preferences by
// chat"). lib/agentTools.ts adds them to the agent's tool list and dispatch table.
//
// Knowledge (the same three lists as the About tab), one tool per verb with a `kind`:
// "profile" (life profile entries: people, places, doctors, habits, interests, preferences),
// "topic" (sensitive-topic guidance for hard questions) and "fact" (remembered facts).
// get_knowledge, add_knowledge, update_knowledge and remove_knowledge call the cores in
// profile.ts that the About tab's mutations call (addEntryCore, updateEntryCore, ...), so
// validation, limits, duplicates, the audit log and the memory rule (a fact the senior said
// never overwrites one a caregiver verified; everything stored here is caregiver-sourced and
// verified, and correcting a fact keeps its source) are the same in both places. Every result
// carries the row exactly as stored (or, for remove_knowledge, as it was), so Sunny can tell
// the caregiver what it stored or removed. add_knowledge reports what happened as status:
// "added", "already_stored" (identical text stored already), "already_stored_differently"
// (same name, topic or fact key with other text; nothing changed) or "confirmed" (a fact the
// senior had said is now verified).
//
// Settings: get_settings returns the digest time, the on-call caregiver, whether caregivers
// see full transcripts (shareTranscripts, agreed with the senior at onboarding), the weather
// place and every caregiver with their role, whether they receive the digest and whether they
// can be reached; update_settings changes the first four through updateHouseholdCore
// (lib/householdSettings.ts, the checks of households.update); set_digest_delivery turns the
// digest's push and text on or off for one caregiver (lib/digestRecipients.ts). Caregivers are named, never given by id: a
// name resolves to one member of the household by display name (whole name, else first name,
// ignoring case and spacing), and an unknown or ambiguous name is refused with the list of
// caregivers. Times are the household's local 24-hour "HH:MM"; the model turns "7 in the
// evening" into "19:00".
//
// Scoping: every tool works on ToolContext.householdId, taken from the request row by the
// runtime, never on an id or household the model supplies; a knowledge_id of another household
// is "not found" (the cores' loadOwned check). The actor is the household agent acting for the
// requesting caregiver, whom the runtime has checked is still an editor (primary or member)
// before any tool runs, so a viewer's request changes nothing; writes are recorded under that
// caregiver.
//
// Last modified: 2026-11-14

import type Anthropic from "@anthropic-ai/sdk";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  addEntryCore,
  addFactCore,
  addTopicCore,
  correctFactCore,
  listMemoryCore,
  listTopicsCore,
  removeEntryCore,
  removeFactCore,
  removeTopicCore,
  updateEntryCore,
  updateTopicCore,
  verifyFactCore,
} from "../profile";
import type { AddResult, EntryChanges, LifeCategory } from "../profile";
import { loadHousehold } from "./access";
import { isReachableMember } from "./delivery";
import { receivesDigest, setDigestDelivery } from "./digestRecipients";
import { appError } from "./errors";
import { updateHouseholdCore } from "./householdSettings";
import type { HouseholdSettingsChanges } from "./householdSettings";
import { entriesInOrder } from "./profileReads";
import { textKey } from "./text";
import { booleanField, changesOf, idField, rejectUnknownKeys, stringField } from "./toolInput";
import type { ToolContext, ToolHandler } from "./toolInput";
import { LIFE_CATEGORIES } from "./validators";

/** The three kinds of knowledge, as the model names them. */
const KNOWLEDGE_KINDS = ["profile", "topic", "fact"] as const;

/** A kind of knowledge. */
type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** The table that holds each kind. */
const KIND_TABLE = {
  profile: "lifeProfileEntries",
  topic: "sensitiveTopics",
  fact: "agentMemory",
} as const;

/** The fields add_knowledge takes for each kind, besides kind itself. */
const ADD_KEYS: Record<KnowledgeKind, readonly string[]> = {
  profile: ["category", "name", "details"],
  topic: ["topic", "guidance"],
  fact: ["fact"],
};

/** The fields update_knowledge's changes may carry for each kind. */
const CHANGE_KEYS: Record<KnowledgeKind, readonly string[]> = {
  profile: ["category", "name", "details"],
  topic: ["topic", "guidance"],
  fact: ["fact", "verified"],
};

/** The settings update_settings may change. */
const SETTINGS_KEYS = ["digest_time", "on_call", "share_transcripts", "weather_location"] as const;

/** The kind and knowledge_id properties shared by update_knowledge and remove_knowledge. */
const KNOWLEDGE_REF = {
  kind: {
    type: "string",
    enum: [...KNOWLEDGE_KINDS],
    description: "Which list the item is in: profile, topic or fact.",
  },
  knowledge_id: {
    type: "string",
    description: "The knowledge_id from get_knowledge or from an earlier knowledge result.",
  },
};

/** The fields of profile, topic and fact items, for add_knowledge and update_knowledge. */
const KNOWLEDGE_FIELDS = {
  category: {
    type: "string",
    enum: [...LIFE_CATEGORIES],
    description: "profile only: person, place, doctor, habit, interest, preference or other.",
  },
  name: {
    type: "string",
    description: 'profile only: who or what, e.g. "Dr. Patel" or "Sarah"; at most 120 characters.',
  },
  details: {
    type: "string",
    description:
      'profile only: optional details in the caregiver\'s words, e.g. "Her doctor; office on Main Street"; at most 600 characters. null clears them on update.',
  },
  topic: {
    type: "string",
    description:
      'topic only: what the senior may ask about, e.g. "her husband Robert"; at most 200 characters.',
  },
  guidance: {
    type: "string",
    description:
      "topic only: how Sunny should answer it, in the caregiver's words; at most 1500 characters.",
  },
  fact: {
    type: "string",
    description:
      'fact only: one plain sentence, e.g. "Her cat is called Biscuit"; at most 300 characters.',
  },
};

/** Custom tool definitions of the setup tools, added to AGENT_TOOLS by lib/agentTools.ts. */
export const SETUP_TOOLS: NonNullable<Anthropic.Beta.Agents.AgentCreateParams["tools"]> = [
  {
    type: "custom",
    name: "get_knowledge",
    description:
      "Read what Sunny knows about the senior's life, as the caregivers' About tab shows it: profile (people, places, doctors, habits, interests, preferences), topic (guidance for hard questions) and fact (remembered facts, each with its source, caregiver or senior, and whether a caregiver verified it). Each item has its kind and knowledge_id. Without kind, all three lists.",
    input_schema: {
      type: "object",
      properties: {
        kind: { ...KNOWLEDGE_REF.kind, description: "Only this list." },
      },
    },
  },
  {
    type: "custom",
    name: "add_knowledge",
    description:
      'Store something the caregiver told you as a fact about the senior\'s life (never something they only asked about). kind profile takes category, name and optional details; topic takes topic and guidance; fact takes fact. The result has status "added", "already_stored", "already_stored_differently" (an item with the same name, topic or text exists with other wording; nothing changed, use update_knowledge if the caregiver wants it changed) or "confirmed" (a fact the senior had said is now verified), and stored: the item exactly as Sunny now has it.',
    input_schema: {
      type: "object",
      properties: { kind: KNOWLEDGE_REF.kind, ...KNOWLEDGE_FIELDS },
      required: ["kind"],
    },
  },
  {
    type: "custom",
    name: "update_knowledge",
    description:
      "Correct an item Sunny knows. Send only the fields that change, in changes: profile category, name or details (null clears details); topic topic or guidance; fact fact (the corrected sentence) or verified true (the caregiver confirms a fact as it stands). A corrected or confirmed fact counts as verified by the caregiver. The result is stored: the item exactly as Sunny now has it.",
    input_schema: {
      type: "object",
      properties: {
        ...KNOWLEDGE_REF,
        changes: {
          type: "object",
          properties: {
            ...KNOWLEDGE_FIELDS,
            verified: { type: "boolean", description: "fact only: true confirms the fact." },
          },
        },
      },
      required: ["kind", "knowledge_id", "changes"],
    },
  },
  {
    type: "custom",
    name: "remove_knowledge",
    description:
      "Remove an item Sunny knows, when the caregiver asks for it to be forgotten or it is wrong and they do not give a correction. The result is removed: the item as it was, so you can say what was removed.",
    input_schema: {
      type: "object",
      properties: KNOWLEDGE_REF,
      required: ["kind", "knowledge_id"],
    },
  },
  {
    type: "custom",
    name: "get_settings",
    description:
      "Read the household's settings: digest_time (when the daily summary is sent, local HH:MM), on_call (the caregiver who gets the first alerts), share_transcripts (whether caregivers may read the senior's full conversations, as agreed with the senior), weather_location (the place Sunny checks the weather for), and caregivers: each one's name, role, whether they are on call, whether they receive the daily summary by push or text (receives_digest) and whether Sunny can reach them at all (reachable: the app with notifications, or a verified phone).",
    input_schema: { type: "object", properties: {} },
  },
  {
    type: "custom",
    name: "update_settings",
    description:
      'Change household settings; send only what changes. digest_time is local 24-hour HH:MM (convert "7 in the evening" to "19:00"). on_call is a caregiver\'s name as the caregivers call them; an unknown or ambiguous name is refused with the list of caregivers. share_transcripts changes what the senior agreed to share, so set it only when the caregiver clearly asks. weather_location is a place such as "Brooklyn, NY"; null or "" clears it. The result has every setting as now stored, as get_settings returns them.',
    input_schema: {
      type: "object",
      properties: {
        digest_time: { type: "string", description: "Local 24-hour HH:MM." },
        on_call: { type: "string", description: "The caregiver's name." },
        share_transcripts: { type: "boolean" },
        weather_location: { type: "string", description: 'e.g. "Brooklyn, NY"; "" clears.' },
      },
    },
  },
  {
    type: "custom",
    name: "set_digest_delivery",
    description:
      "Turn the daily summary's push and text on or off for one caregiver, named as the caregivers call them. The summary is still posted in this chat for everyone. The result names the caregiver and their setting now.",
    input_schema: {
      type: "object",
      properties: {
        caregiver: { type: "string", description: "The caregiver's name." },
        receives: { type: "boolean", description: "true to receive it, false to stop it." },
      },
      required: ["caregiver", "receives"],
    },
  },
];

/**
 * purpose: Read the kind of a knowledge tool's input.
 * @param value: (unknown) The field's value.
 * @return: (KnowledgeKind) profile, topic or fact.
 * @raises invalid for anything else.
 */
function kindField(value: unknown): KnowledgeKind {
  const kind = stringField(value, "kind");
  if (!KNOWLEDGE_KINDS.includes(kind as KnowledgeKind)) {
    throw appError("invalid", `kind must be one of ${KNOWLEDGE_KINDS.join(", ")}`);
  }
  return kind as KnowledgeKind;
}

/**
 * purpose: Read a life profile category from tool input.
 * @param value: (unknown) The field's value.
 * @return: (LifeCategory) The category.
 * @raises invalid when it is not one of the categories.
 */
function categoryField(value: unknown): LifeCategory {
  const category = stringField(value, "category");
  if (!LIFE_CATEGORIES.includes(category)) {
    throw appError("invalid", `category must be one of ${LIFE_CATEGORIES.join(", ")}`);
  }
  return category as LifeCategory;
}

/**
 * purpose: Read the knowledge_id of a kind from tool input.
 * @param ctx: (MutationCtx) Context.
 * @param kind: (KnowledgeKind) The kind, which decides the table.
 * @param input: (Record<string, unknown>) Tool input.
 * @return: (Id<"lifeProfileEntries" | "sensitiveTopics" | "agentMemory">) The id.
 * @raises invalid when missing or not an id of that kind.
 */
function knowledgeId<K extends KnowledgeKind>(
  ctx: MutationCtx,
  kind: K,
  input: Record<string, unknown>,
): Id<(typeof KIND_TABLE)[K]> {
  return idField(ctx, KIND_TABLE[kind], input.knowledge_id, "knowledge_id", "get_knowledge");
}

/**
 * purpose: A life profile entry the way the model reads it.
 * @param entry: (Doc<"lifeProfileEntries">) The entry.
 * @return: (Record<string, unknown>) JSON-ready item.
 */
function entryForModel(entry: Doc<"lifeProfileEntries">): Record<string, unknown> {
  return {
    kind: "profile",
    knowledge_id: entry._id,
    category: entry.category,
    name: entry.name,
    details: entry.details ?? null,
  };
}

/**
 * purpose: A sensitive topic the way the model reads it.
 * @param topic: (Doc<"sensitiveTopics">) The topic.
 * @return: (Record<string, unknown>) JSON-ready item.
 */
function topicForModel(topic: Doc<"sensitiveTopics">): Record<string, unknown> {
  return { kind: "topic", knowledge_id: topic._id, topic: topic.topic, guidance: topic.guidance };
}

/**
 * purpose: A remembered fact the way the model reads it.
 * @param fact: (Doc<"agentMemory">) The fact.
 * @return: (Record<string, unknown>) JSON-ready item.
 */
function factForModel(fact: Doc<"agentMemory">): Record<string, unknown> {
  return {
    kind: "fact",
    knowledge_id: fact._id,
    fact: fact.fact,
    source: fact.source,
    verified: fact.verifiedAt !== undefined,
  };
}

/**
 * purpose: add_knowledge's status for an add result.
 * @param result: (AddResult<...>) What the core returned.
 * @return: (string) added, confirmed, already_stored or already_stored_differently.
 */
function addStatus(
  result: AddResult<"lifeProfileEntries" | "sensitiveTopics" | "agentMemory">,
): string {
  if (result.created) return "added";
  if (result.confirmed) return "confirmed";
  return result.same ? "already_stored" : "already_stored_differently";
}

/**
 * purpose: Load a row a core just wrote or returned, to show it as stored.
 * @param ctx: (QueryCtx) Context.
 * @param id: (Id<T>) The row.
 * @return: (Promise<Doc<T>>) The row.
 */
async function storedRow<T extends "lifeProfileEntries" | "sensitiveTopics" | "agentMemory">(
  ctx: QueryCtx,
  id: Id<T>,
): Promise<Doc<T>> {
  return (await ctx.db.get(id))!;
}

/**
 * purpose: add_knowledge for one kind: check the keys, call the About tab's add core, and
 *          return the status and the item as stored.
 * @param ctx: (MutationCtx) Context.
 * @param toolCtx: (ToolContext) Household and agent actor from the request row.
 * @param kind: (KnowledgeKind) The kind.
 * @param fields: (Record<string, unknown>) The input without kind.
 * @return: (Promise<{ status: string; stored: Record<string, unknown> }>) The outcome.
 * @raises invalid for an unknown field, a wrong type or any rule of the core.
 */
async function addKnowledge(
  ctx: MutationCtx,
  { householdId, actor }: ToolContext,
  kind: KnowledgeKind,
  fields: Record<string, unknown>,
): Promise<{ status: string; stored: Record<string, unknown> }> {
  rejectUnknownKeys(fields, ADD_KEYS[kind]);
  if (kind === "profile") {
    const details =
      fields.details === undefined ? null : stringField(fields.details, "details", true);
    const result = await addEntryCore(ctx, actor, householdId, {
      category: categoryField(fields.category),
      name: stringField(fields.name, "name"),
      details: details ?? undefined,
    });
    return { status: addStatus(result), stored: entryForModel(await storedRow(ctx, result.id)) };
  }
  if (kind === "topic") {
    const result = await addTopicCore(ctx, actor, householdId, {
      topic: stringField(fields.topic, "topic"),
      guidance: stringField(fields.guidance, "guidance"),
    });
    return { status: addStatus(result), stored: topicForModel(await storedRow(ctx, result.id)) };
  }
  const result = await addFactCore(ctx, actor, householdId, stringField(fields.fact, "fact"));
  return { status: addStatus(result), stored: factForModel(await storedRow(ctx, result.id)) };
}

/**
 * purpose: update_knowledge for one kind: check the change keys and call the About tab's update
 *          core (for a fact: correct when a new text is given, else verify).
 * @param ctx: (MutationCtx) Context.
 * @param toolCtx: (ToolContext) Household and agent actor from the request row.
 * @param kind: (KnowledgeKind) The kind.
 * @param input: (Record<string, unknown>) The tool input (knowledge_id and changes).
 * @return: (Promise<Record<string, unknown>>) The item as stored after the change.
 * @raises invalid for an unknown or empty change, a wrong type or any rule of the core;
 *         not_found for an item of another household.
 */
async function updateKnowledge(
  ctx: MutationCtx,
  { householdId, actor }: ToolContext,
  kind: KnowledgeKind,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const changes = changesOf(input);
  rejectUnknownKeys(changes, CHANGE_KEYS[kind]);
  if (Object.keys(changes).length === 0) throw appError("invalid", "changes is empty");
  if (kind === "profile") {
    const mapped: EntryChanges = {};
    if (changes.category !== undefined) mapped.category = categoryField(changes.category);
    if (changes.name !== undefined) mapped.name = stringField(changes.name, "name");
    if (changes.details !== undefined) {
      mapped.details = stringField(changes.details, "details", true);
    }
    const id = knowledgeId(ctx, "profile", input);
    return entryForModel(await updateEntryCore(ctx, actor, householdId, id, mapped));
  }
  if (kind === "topic") {
    const id = knowledgeId(ctx, "topic", input);
    const topic = await updateTopicCore(ctx, actor, householdId, id, {
      topic: changes.topic === undefined ? undefined : stringField(changes.topic, "topic"),
      guidance:
        changes.guidance === undefined ? undefined : stringField(changes.guidance, "guidance"),
    });
    return topicForModel(topic);
  }
  const id = knowledgeId(ctx, "fact", input);
  if (changes.verified !== undefined && booleanField(changes.verified, "verified") !== true) {
    throw appError("invalid", "verified can only be true; use remove_knowledge for a wrong fact");
  }
  const fact =
    changes.fact === undefined
      ? await verifyFactCore(ctx, actor, householdId, id)
      : await correctFactCore(ctx, actor, householdId, id, stringField(changes.fact, "fact"));
  return factForModel(fact);
}

/**
 * purpose: remove_knowledge for one kind: call the About tab's remove core.
 * @param ctx: (MutationCtx) Context.
 * @param toolCtx: (ToolContext) Household and agent actor from the request row.
 * @param kind: (KnowledgeKind) The kind.
 * @param input: (Record<string, unknown>) The tool input (knowledge_id).
 * @return: (Promise<Record<string, unknown>>) The item as it was before removal.
 * @raises not_found for an item of another household; invalid for a malformed id.
 */
async function removeKnowledge(
  ctx: MutationCtx,
  { householdId, actor }: ToolContext,
  kind: KnowledgeKind,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (kind === "profile") {
    const id = knowledgeId(ctx, "profile", input);
    return entryForModel(await removeEntryCore(ctx, actor, householdId, id));
  }
  if (kind === "topic") {
    const id = knowledgeId(ctx, "topic", input);
    return topicForModel(await removeTopicCore(ctx, actor, householdId, id));
  }
  const id = knowledgeId(ctx, "fact", input);
  return factForModel(await removeFactCore(ctx, actor, householdId, id));
}

/**
 * purpose: The household's caregivers (householdMembers holds caregivers only, never devices).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"householdMembers">[]>) The members.
 */
async function caregivers(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"householdMembers">[]> {
  return await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId))
    .collect();
}

/**
 * purpose: Find the one caregiver of the household a name means: the members whose whole
 *          display name matches (ignoring case and spacing), or failing that whose first name
 *          does. Anything but exactly one match is refused, listing the caregivers so the model
 *          can ask which one the caregiver means.
 * @param members: (Doc<"householdMembers">[]) The household's caregivers.
 * @param name: (string) The name the caregiver used.
 * @return: (Doc<"householdMembers">) The caregiver.
 * @raises invalid for an unknown or ambiguous name.
 */
export function resolveCaregiver(
  members: Doc<"householdMembers">[],
  name: string,
): Doc<"householdMembers"> {
  const wanted = textKey(name);
  const whole = members.filter((m) => textKey(m.displayName) === wanted);
  const matches = whole.length
    ? whole
    : members.filter((m) => textKey(m.displayName).split(" ")[0] === wanted);
  if (matches.length === 1) return matches[0]!;
  /**
   * purpose: Caregivers' names as one comma-separated list, for the refusal.
   * @param rows: (Doc<"householdMembers">[]) The caregivers.
   * @return: (string) Their display names.
   */
  const list = (rows: Doc<"householdMembers">[]): string =>
    rows.map((m) => m.displayName).join(", ");
  if (matches.length === 0) {
    throw appError(
      "invalid",
      `No caregiver of this household is called "${name}". The caregivers are: ${list(members)}. Ask which one they mean.`,
    );
  }
  throw appError(
    "invalid",
    `More than one caregiver could be "${name}": ${list(matches)}. Ask which one they mean.`,
  );
}

/**
 * purpose: One caregiver as get_settings and set_digest_delivery show them.
 * @param ctx: (QueryCtx) Context.
 * @param member: (Doc<"householdMembers">) The caregiver.
 * @param onCallUserId: (string | undefined) The household's on-call caregiver.
 * @return: (Promise<Record<string, unknown>>) name, role, on_call, receives_digest, reachable.
 */
async function caregiverForModel(
  ctx: QueryCtx,
  member: Doc<"householdMembers">,
  onCallUserId: string | undefined,
): Promise<Record<string, unknown>> {
  return {
    name: member.displayName,
    role: member.role,
    on_call: member.userId === onCallUserId,
    receives_digest: receivesDigest(member),
    reachable: await isReachableMember(ctx, member),
  };
}

/**
 * purpose: The household's settings as get_settings and update_settings return them.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household as stored.
 * @return: (Promise<Record<string, unknown>>) digest_time, on_call (a name or null),
 *          share_transcripts, weather_location (or null) and caregivers.
 */
async function settingsForModel(
  ctx: QueryCtx,
  household: Doc<"households">,
): Promise<Record<string, unknown>> {
  const members = await caregivers(ctx, household._id);
  const onCall = members.find((m) => m.userId === household.onCallUserId);
  return {
    digest_time: household.digestTime,
    on_call: onCall?.displayName ?? null,
    share_transcripts: household.shareTranscripts,
    weather_location: household.weatherLocation ?? null,
    caregivers: await Promise.all(
      members.map((m) => caregiverForModel(ctx, m, household.onCallUserId)),
    ),
  };
}

/**
 * purpose: Map update_settings input to the household core's changes, resolving on_call to a
 *          member. A weather_location of null or "" clears it.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param input: (Record<string, unknown>) update_settings input.
 * @return: (Promise<HouseholdSettingsChanges>) The changes.
 * @raises invalid for an unknown or missing field, a wrong type, or an unknown or ambiguous
 *         caregiver name.
 */
async function settingsChanges(
  ctx: QueryCtx,
  householdId: Id<"households">,
  input: Record<string, unknown>,
): Promise<HouseholdSettingsChanges> {
  rejectUnknownKeys(input, SETTINGS_KEYS);
  if (Object.keys(input).length === 0) throw appError("invalid", "Nothing to change");
  const changes: HouseholdSettingsChanges = {};
  if (input.digest_time !== undefined) {
    changes.digestTime = stringField(input.digest_time, "digest_time");
  }
  if (input.on_call !== undefined) {
    const member = resolveCaregiver(
      await caregivers(ctx, householdId),
      stringField(input.on_call, "on_call"),
    );
    changes.onCallUserId = member.userId;
  }
  if (input.share_transcripts !== undefined) {
    changes.shareTranscripts = booleanField(input.share_transcripts, "share_transcripts");
  }
  if (input.weather_location !== undefined) {
    changes.weatherLocation = stringField(input.weather_location, "weather_location", true) ?? "";
  }
  return changes;
}

/** The setup tools, by name (the names of SETUP_TOOLS). */
export type SetupToolName =
  | "get_knowledge"
  | "add_knowledge"
  | "update_knowledge"
  | "remove_knowledge"
  | "get_settings"
  | "update_settings"
  | "set_digest_delivery";

/** The setup tool handlers, merged into lib/agentTools.ts's dispatch table. */
export const SETUP_TOOL_HANDLERS: Record<SetupToolName, ToolHandler> = {
  get_knowledge: async (ctx, { householdId }, input) => {
    rejectUnknownKeys(input, ["kind"]);
    const only = input.kind === undefined ? null : kindField(input.kind);
    const out: Record<string, unknown> = {};
    if (only === null || only === "profile") {
      out.profile = (await entriesInOrder(ctx, householdId)).map(entryForModel);
    }
    if (only === null || only === "topic") {
      out.topics = (await listTopicsCore(ctx, householdId)).map(topicForModel);
    }
    if (only === null || only === "fact") {
      const memory = await listMemoryCore(ctx, householdId);
      out.facts = memory.facts.map(factForModel);
      out.older_unverified_facts = memory.olderUnverified;
    }
    return out;
  },
  add_knowledge: async (ctx, toolCtx, input) => {
    const { kind, ...fields } = input;
    return await addKnowledge(ctx, toolCtx, kindField(kind), fields);
  },
  update_knowledge: async (ctx, toolCtx, input) => {
    rejectUnknownKeys(input, ["kind", "knowledge_id", "changes"]);
    return { stored: await updateKnowledge(ctx, toolCtx, kindField(input.kind), input) };
  },
  remove_knowledge: async (ctx, toolCtx, input) => {
    rejectUnknownKeys(input, ["kind", "knowledge_id"]);
    return { removed: await removeKnowledge(ctx, toolCtx, kindField(input.kind), input) };
  },
  get_settings: async (ctx, { householdId }, input) => {
    rejectUnknownKeys(input, []);
    return await settingsForModel(ctx, await loadHousehold(ctx, householdId));
  },
  update_settings: async (ctx, { householdId, actor }, input) => {
    const changes = await settingsChanges(ctx, householdId, input);
    return await settingsForModel(ctx, await updateHouseholdCore(ctx, actor, householdId, changes));
  },
  set_digest_delivery: async (ctx, { householdId, actor }, input) => {
    rejectUnknownKeys(input, ["caregiver", "receives"]);
    const members = await caregivers(ctx, householdId);
    const member = resolveCaregiver(members, stringField(input.caregiver, "caregiver"));
    const receives = booleanField(input.receives, "receives");
    const household = await loadHousehold(ctx, householdId);
    const updated = await setDigestDelivery(ctx, actor, member, receives);
    return await caregiverForModel(ctx, updated, household.onCallUserId);
  },
};
