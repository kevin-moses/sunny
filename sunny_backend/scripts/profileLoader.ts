// scripts/profileLoader.ts
// Purpose: The bulk life-profile loader behind `scripts/caregiver.ts profile-load <file.json>`,
// kept apart from the command line so it can be tested against the real mutations
// (convex/profileLoader.test.ts). parseProfileFile checks the file's shape; loadProfile sends
// every item through the public profile mutations (profile:addEntry, profile:addTopic,
// profile:addFact), which trim, cap and de-duplicate, so loading the same file twice adds
// nothing the second time. Each item is reported as:
//   added      inserted;
//   unchanged  already stored with the same text;
//   confirmed  a fact the senior had said, now confirmed by the load;
//   differs    already stored with different text (details or guidance) and NOT updated;
//   updated    already stored with different text, and replaced because of --update (through
//              profile:updateEntry or profile:updateTopic);
//   failed     the server refused it (the rest still load).
// cliError turns the stderr of a failed `npx convex run` into an Error carrying the server's
// message (the ConvexError's message when there is one).
//
// File format (see scripts/profile.example.json; keep real data in scripts/*.local.json, which
// git ignores):
//   {
//     "lifeProfile": [{ "category": "person", "name": "Sarah", "details": "Daughter" }, ...],
//     "sensitiveTopics": [{ "topic": "her husband Robert", "guidance": "..." }, ...],
//     "facts": ["Her cat is called Biscuit", ...]
//   }
// Every section is optional. category is one of person, place, doctor, habit, interest,
// preference, other; details is optional. Top-level keys starting with "_" are notes and are
// ignored; any other unknown key, at the top or inside an item, is an error (it is most likely a
// misspelling, such as "detials", that would otherwise load the item without it).
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
  unchanged: string[];
  confirmed: string[];
  differs: string[];
  updated: string[];
  failed: Array<{ item: string; error: string }>;
}

/** What an add mutation returns (see profile.ts AddResult). */
interface AddResult {
  id: string;
  created: boolean;
  same: boolean;
  confirmed: boolean;
}

/** One item to load: its label, add mutation and arguments, and how to update it. */
interface LoadItem {
  label: string;
  fn: string;
  args: Record<string, unknown>;
  /** The update mutation and its arguments for an existing row id; absent for facts. */
  update?: (id: string) => [string, Record<string, unknown>];
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
 * purpose: Check an item is an object with only the allowed keys.
 * @param item: (unknown) The item.
 * @param where: (string) Its position, for the error message.
 * @param allowed: (readonly string[]) The keys it may have.
 * @return: (Record<string, unknown>) The item.
 * @raises Error when it is not an object or has another key.
 */
function itemObject(
  item: unknown,
  where: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isObject(item)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) {
      throw new Error(`${where}: unknown key "${key}"; expected ${allowed.join(", ")}`);
    }
  }
  return item;
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
 * @raises Error naming the first problem: not an object, an unknown key (top level or in an
 *         item), a section that is not a list, an item that is not an object, a missing or
 *         non-text field, an unknown category.
 */
export function parseProfileFile(raw: unknown): ProfileFile {
  if (!isObject(raw)) throw new Error("The file must hold a JSON object");
  for (const key of Object.keys(raw)) {
    if (!key.startsWith("_") && !(SECTIONS as readonly string[]).includes(key)) {
      throw new Error(`Unknown key "${key}"; expected ${SECTIONS.join(", ")}`);
    }
  }
  const lifeProfile = section(raw, "lifeProfile").map((value, i) => {
    const where = `lifeProfile[${i}]`;
    const item = itemObject(value, where, ["category", "name", "details"]);
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
  const sensitiveTopics = section(raw, "sensitiveTopics").map((value, i) => {
    const where = `sensitiveTopics[${i}]`;
    const item = itemObject(value, where, ["topic", "guidance"]);
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
 * purpose: Turn the stderr of a failed `npx convex run` into an Error with a readable message.
 *          The CLI prints `Failed to run function "<fn>":`, then `ConvexError: [Request ID: ...]
 *          Server Error`, then `Uncaught ConvexError: {"code":...,"message":...}` and a stack;
 *          the message of that JSON is used when present, else the text after the header line.
 * @param stderr: (string) What the CLI wrote to stderr (colors are stripped).
 * @param fallback: (string) Message when stderr holds nothing useful.
 * @return: (Error) The error to throw.
 */
export function cliError(stderr: string, fallback: string): Error {
  // eslint-disable-next-line no-control-regex
  const text = stderr.replace(/\u001b\[[0-9;]*m/g, "");
  const json = /Uncaught ConvexError: (\{.*\})/.exec(text)?.[1];
  if (json !== undefined) {
    try {
      const data = JSON.parse(json) as { message?: unknown };
      if (typeof data.message === "string") return new Error(data.message);
    } catch {
      // Not JSON after all; fall through to the raw text.
    }
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/Failed to run function/.test(line) && !/^at /.test(line));
  return new Error(lines.join(" ") || fallback);
}

/**
 * purpose: The items of a profile file in load order, with their add and update mutations.
 * @param file: (ProfileFile) Parsed file.
 * @return: (LoadItem[]) Entries, then topics, then facts.
 */
function loadItems(file: ProfileFile): LoadItem[] {
  return [
    ...file.lifeProfile.map((args) => ({
      label: `${args.category}: ${args.name}`,
      fn: "profile:addEntry",
      args,
      update: (id: string): [string, Record<string, unknown>] => [
        "profile:updateEntry",
        { entryId: id, name: args.name, details: args.details ?? null },
      ],
    })),
    ...file.sensitiveTopics.map((args) => ({
      label: `topic: ${args.topic}`,
      fn: "profile:addTopic",
      args,
      update: (id: string): [string, Record<string, unknown>] => [
        "profile:updateTopic",
        { topicId: id, topic: args.topic, guidance: args.guidance },
      ],
    })),
    ...file.facts.map((fact) => ({
      label: `fact: ${fact}`,
      fn: "profile:addFact",
      args: { fact },
    })),
  ];
}

/**
 * purpose: Load every item of a profile file through the public mutations, one at a time.
 * @param file: (ProfileFile) Parsed file.
 * @param householdId: (string) The household to load into.
 * @param call: (MutationCaller) Runs a mutation as the caregiver.
 * @param options: ({ update?: boolean }) With update, an item stored with different text is
 *        replaced by the file's text (an entry without details in the file loses its details).
 * @return: (Promise<LoadReport>) What happened to each item.
 */
export async function loadProfile(
  file: ProfileFile,
  householdId: string,
  call: MutationCaller,
  options: { update?: boolean } = {},
): Promise<LoadReport> {
  const report: LoadReport = {
    added: [],
    unchanged: [],
    confirmed: [],
    differs: [],
    updated: [],
    failed: [],
  };
  for (const { label, fn, args, update } of loadItems(file)) {
    try {
      const result = (await call(fn, { householdId, ...args })) as AddResult;
      if (result.created) report.added.push(label);
      else if (result.confirmed) report.confirmed.push(label);
      else if (result.same || update === undefined) report.unchanged.push(label);
      else if (!options.update) report.differs.push(label);
      else {
        const [updateFn, updateArgs] = update(result.id);
        await call(updateFn, { householdId, ...updateArgs });
        report.updated.push(label);
      }
    } catch (e) {
      report.failed.push({ item: label, error: errorText(e) });
    }
  }
  return report;
}
