// scripts/profileLoader.ts
// Purpose: The bulk life-profile loader behind `scripts/caregiver.ts profile-load <file.json>`,
// kept apart from the command line so it can be tested against the real mutations
// (convex/profileLoader.test.ts). parseProfileFile checks the file's shape; loadProfile sends
// every item through the public profile mutations (profile:addEntry, profile:addTopic,
// profile:addFact), which trim, cap and de-duplicate, so loading the same file twice adds
// nothing the second time. It reports each item as added, skipped (already stored) or failed
// (the server refused it; the rest still load).
//
// File format (see scripts/profile.example.json):
//   {
//     "lifeProfile": [{ "category": "person", "name": "Sarah", "details": "Daughter" }, ...],
//     "sensitiveTopics": [{ "topic": "her husband Robert", "guidance": "..." }, ...],
//     "facts": ["Her cat is called Biscuit", ...]
//   }
// Every section is optional. category is one of person, place, doctor, habit, interest,
// preference, other; details is optional. Top-level keys starting with "_" are notes and are
// ignored; any other unknown key is an error (it is most likely a misspelled section).
//
// Last modified: 2026-11-09

import { lifeCategory } from "../convex/lib/validators";

/** The life profile categories the backend accepts. */
const CATEGORIES: readonly string[] = lifeCategory.members.map((m) => m.value as string);

/** The sections a profile file may have. */
const SECTIONS = ["lifeProfile", "sensitiveTopics", "facts"] as const;

/** A parsed profile file. */
export interface ProfileFile {
  lifeProfile: Array<{ category: string; name: string; details?: string }>;
  sensitiveTopics: Array<{ topic: string; guidance: string }>;
  facts: string[];
}

/** Calls a public mutation by name ("profile:addEntry") as the caregiver; returns its result. */
export type MutationCaller = (fn: string, args: Record<string, unknown>) => unknown;

/** What loading did with each item, by its label (for example "person: Sarah"). */
export interface LoadReport {
  added: string[];
  skipped: string[];
  failed: Array<{ item: string; error: string }>;
}

/**
 * purpose: Whether a value is a plain object (not null, not an array).
 * @param value: (unknown) Candidate.
 * @return: (boolean) True for a plain object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * purpose: Read one string field of an item.
 * @param item: (Record<string, unknown>) The item.
 * @param key: (string) Field name.
 * @param where: (string) The item's position, for the error message.
 * @param optional: (boolean) Whether the field may be absent.
 * @return: (string | undefined) The value.
 * @raises Error when the field is not a string (or is missing and required).
 */
function stringField(
  item: Record<string, unknown>,
  key: string,
  where: string,
  optional = false,
): string | undefined {
  const value = item[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new Error(`${where}: "${key}" must be text`);
  return value;
}

/**
 * purpose: Read one section as an array (an absent section is empty).
 * @param raw: (Record<string, unknown>) The file.
 * @param key: (string) Section name.
 * @return: (unknown[]) The section's items.
 * @raises Error when the section is present but not an array.
 */
function section(raw: Record<string, unknown>, key: string): unknown[] {
  const value = raw[key] ?? [];
  if (!Array.isArray(value)) throw new Error(`"${key}" must be a list`);
  return value;
}

/**
 * purpose: Check a profile file's shape and return its items. Text is not trimmed or capped
 *          here; the server does that (and refuses what is too long).
 * @param raw: (unknown) The parsed JSON.
 * @return: (ProfileFile) The items, with absent sections empty.
 * @raises Error naming the first problem: not an object, an unknown key, a section that is not
 *         a list, an item that is not an object, a missing or non-text field, an unknown category.
 */
export function parseProfileFile(raw: unknown): ProfileFile {
  if (!isObject(raw)) throw new Error("The file must hold a JSON object");
  for (const key of Object.keys(raw)) {
    if (!key.startsWith("_") && !(SECTIONS as readonly string[]).includes(key)) {
      throw new Error(`Unknown key "${key}"; expected ${SECTIONS.join(", ")}`);
    }
  }
  const lifeProfile = section(raw, "lifeProfile").map((item, i) => {
    const where = `lifeProfile[${i}]`;
    if (!isObject(item)) throw new Error(`${where} must be an object`);
    const category = stringField(item, "category", where)!;
    if (!CATEGORIES.includes(category)) {
      throw new Error(`${where}: category must be one of ${CATEGORIES.join(", ")}`);
    }
    const details = stringField(item, "details", where, true);
    return {
      category,
      name: stringField(item, "name", where)!,
      ...(details === undefined ? {} : { details }),
    };
  });
  const sensitiveTopics = section(raw, "sensitiveTopics").map((item, i) => {
    const where = `sensitiveTopics[${i}]`;
    if (!isObject(item)) throw new Error(`${where} must be an object`);
    return {
      topic: stringField(item, "topic", where)!,
      guidance: stringField(item, "guidance", where)!,
    };
  });
  const facts = section(raw, "facts").map((item, i) => {
    if (typeof item !== "string") throw new Error(`facts[${i}] must be text`);
    return item;
  });
  return { lifeProfile, sensitiveTopics, facts };
}

/**
 * purpose: The message of a thrown value.
 * @param e: (unknown) Thrown value.
 * @return: (string) Its message (the server's message for an application error).
 */
function errorText(e: unknown): string {
  const data = (e as { data?: { message?: unknown } } | null)?.data;
  if (typeof data?.message === "string") return data.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * purpose: Load every item of a profile file through the public mutations, one at a time.
 * @param file: (ProfileFile) Parsed file.
 * @param householdId: (string) The household to load into.
 * @param call: (MutationCaller) Runs a mutation as the caregiver.
 * @return: (Promise<LoadReport>) What was added, skipped as already stored, and refused.
 */
export async function loadProfile(
  file: ProfileFile,
  householdId: string,
  call: MutationCaller,
): Promise<LoadReport> {
  const report: LoadReport = { added: [], skipped: [], failed: [] };
  const items: Array<{ label: string; fn: string; args: Record<string, unknown> }> = [
    ...file.lifeProfile.map((args) => ({
      label: `${args.category}: ${args.name}`,
      fn: "profile:addEntry",
      args,
    })),
    ...file.sensitiveTopics.map((args) => ({
      label: `topic: ${args.topic}`,
      fn: "profile:addTopic",
      args,
    })),
    ...file.facts.map((fact) => ({
      label: `fact: ${fact}`,
      fn: "profile:addFact",
      args: { fact },
    })),
  ];
  for (const { label, fn, args } of items) {
    try {
      const result = (await call(fn, { householdId, ...args })) as { created: boolean };
      (result.created ? report.added : report.skipped).push(label);
    } catch (e) {
      report.failed.push({ item: label, error: errorText(e) });
    }
  }
  return report;
}
