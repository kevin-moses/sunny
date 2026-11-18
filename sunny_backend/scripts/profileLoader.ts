import type { AddResult } from "../convex/profile";
import { parseJsonObject } from "../convex/lib/http";
import { LIFE_CATEGORIES } from "../convex/lib/validators";

const SECTIONS = ["lifeProfile", "sensitiveTopics", "facts"] as const;

export interface ProfileFile {
  lifeProfile: { category: string; name: string; details?: string | null }[];
  sensitiveTopics: { topic: string; guidance: string }[];
  facts: string[];
}

export type MutationCaller = (fn: string, args: Record<string, unknown>) => unknown;

export interface LoadReport {
  added: string[];
  unchanged: string[];
  confirmed: string[];
  differs: string[];
  updated: string[];
  failed: { item: string; error: string }[];
}

interface LoadItem {
  label: string;
  fn: string;
  args: Record<string, unknown>;
  update?: (id: string) => { fn: string; args: Record<string, unknown>; note: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function stringField(item: Record<string, unknown>, key: string, where: string): string {
  const value = item[key];
  if (typeof value !== "string") throw new Error(`${where}: "${key}" must be text`);
  return value;
}

function section(raw: Record<string, unknown>, key: string): unknown[] {
  const value = raw[key] ?? [];
  if (!Array.isArray(value)) throw new Error(`"${key}" must be a list`);
  return value;
}

function parseEntry(value: unknown, where: string): ProfileFile["lifeProfile"][number] {
  const item = itemObject(value, where, ["category", "name", "details"]);
  const category = stringField(item, "category", where);
  if (!LIFE_CATEGORIES.includes(category)) {
    throw new Error(`${where}: category must be one of ${LIFE_CATEGORIES.join(", ")}`);
  }
  const entry = { category, name: stringField(item, "name", where) };
  if (!("details" in item)) return entry;
  const details = item.details;
  if (details !== null && typeof details !== "string") {
    throw new Error(`${where}: "details" must be text or null`);
  }
  return { ...entry, details };
}

export function parseProfileFile(raw: unknown): ProfileFile {
  if (!isObject(raw)) throw new Error("The file must hold a JSON object");
  for (const key of Object.keys(raw)) {
    if (!key.startsWith("_") && !(SECTIONS as readonly string[]).includes(key)) {
      throw new Error(`Unknown key "${key}"; expected ${SECTIONS.join(", ")}`);
    }
  }
  const lifeProfile = section(raw, "lifeProfile").map((value, i) =>
    parseEntry(value, `lifeProfile[${i}]`),
  );
  const sensitiveTopics = section(raw, "sensitiveTopics").map((value, i) => {
    const where = `sensitiveTopics[${i}]`;
    const item = itemObject(value, where, ["topic", "guidance"]);
    return {
      topic: stringField(item, "topic", where),
      guidance: stringField(item, "guidance", where),
    };
  });
  const facts = section(raw, "facts").map((item, i) => {
    if (typeof item !== "string") throw new Error(`facts[${i}] must be text`);
    return item;
  });
  return { lifeProfile, sensitiveTopics, facts };
}

function errorText(e: unknown): string {
  const data = (e as { data?: { message?: unknown } } | null)?.data;
  if (typeof data?.message === "string") return data.message;
  return e instanceof Error ? e.message : String(e);
}

const ANSI_ESCAPE = String.fromCharCode(0x1b);
const ANSI_COLOR_SEQUENCE = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

export function cliError(stderr: string, fallback: string): Error {
  const text = stderr.replace(ANSI_COLOR_SEQUENCE, "");
  const json = /Uncaught ConvexError: (\{.*\})/.exec(text)?.[1];
  const message = json === undefined ? undefined : parseJsonObject(json)?.message;
  if (typeof message === "string") return new Error(message);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/Failed to run function/.test(line) && !/^at /.test(line));
  return new Error(lines.join(" ") || fallback);
}

function entryItem(entry: ProfileFile["lifeProfile"][number]): LoadItem {
  const { category, name, details } = entry;
  const hasDetails = "details" in entry;
  const clears = hasDetails && (details ?? "").trim() === "";
  return {
    label: `${category}: ${name}`,
    fn: "profile:addEntry",
    args: { category, name, ...(hasDetails ? { details: details ?? "" } : {}) },
    update: (id) => ({
      fn: "profile:updateEntry",
      args: { entryId: id, name, ...(hasDetails ? { details: clears ? null : details } : {}) },
      note: clears ? " (details cleared)" : "",
    }),
  };
}

function loadItems(file: ProfileFile): LoadItem[] {
  return [
    ...file.lifeProfile.map(entryItem),
    ...file.sensitiveTopics.map((args) => ({
      label: `topic: ${args.topic}`,
      fn: "profile:addTopic",
      args,
      update: (id: string) => ({
        fn: "profile:updateTopic",
        args: { topicId: id, ...args },
        note: "",
      }),
    })),
    ...file.facts.map((fact) => ({
      label: `fact: ${fact}`,
      fn: "profile:addFact",
      args: { fact },
    })),
  ];
}

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
    let result: AddResult<"lifeProfileEntries" | "sensitiveTopics" | "agentMemory">;
    try {
      result = (await call(fn, { householdId, ...args })) as typeof result;
    } catch (e) {
      report.failed.push({ item: label, error: errorText(e) });
      continue;
    }
    if (result.created) report.added.push(label);
    else if (result.confirmed) report.confirmed.push(label);
    else if (result.same || update === undefined) report.unchanged.push(label);
    else if (!options.update) report.differs.push(label);
    else {
      const change = update(result.id);
      try {
        await call(change.fn, { householdId, ...change.args });
        report.updated.push(`${label}${change.note}`);
      } catch (e) {
        report.failed.push({ item: label, error: `update: ${errorText(e)}` });
      }
    }
  }
  return report;
}
