// lib/toolInput.ts
// Purpose: What every household agent tool shares, used by the schedule tools
// (lib/agentTools.ts) and the setup tools (lib/agentSetupTools.ts): the ToolContext a tool runs
// with (household, agent actor and clock, all from the request row, never from the model), the
// handler type, and the readers that type the model's input. A reader that finds a wrong type
// throws an "invalid" application error whose message the model reads and can act on
// (executeAgentTool turns it into "Error: <message>").
//
// Last modified: 2026-11-14

import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AgentActor } from "./access";
import { appError } from "./errors";
import { requireNonBlank } from "./text";

/** Everything a tool needs besides the model's input; built from the request row. */
export interface ToolContext {
  /** Household of the request (never from the model). */
  householdId: Id<"households">;
  /** The agent actor, carrying the requesting caregiver (onBehalfOf) and the request. */
  actor: AgentActor;
  /** Epoch ms the calendar's "not in the past" rules and instance expansion use. */
  now: number;
}

/** A tool: runs with the context and the model's input, returns the raw result. */
export type ToolHandler = (
  ctx: MutationCtx,
  toolCtx: ToolContext,
  input: Record<string, unknown>,
) => Promise<unknown>;

/**
 * purpose: Read a string field of tool input. Required fields must be non-blank strings;
 *          optional fields may also be null (null means clear on update) or blank.
 * @param value: (unknown) The field's value.
 * @param key: (string) Field name, for the error message.
 * @param optional: (boolean) Whether null is allowed (and blank is kept as is).
 * @return: (string | null) The string (trimmed when required), or null.
 * @raises invalid (an application error the model can read) for anything else.
 */
export function stringField(value: unknown, key: string, optional: true): string | null;
export function stringField(value: unknown, key: string, optional?: false): string;
export function stringField(value: unknown, key: string, optional = false): string | null {
  if (optional && value === null) return null;
  if (typeof value !== "string") {
    throw appError(
      "invalid",
      optional ? `${key} must be a string` : `${key} is missing or malformed`,
    );
  }
  return optional ? value : requireNonBlank(value, key);
}

/**
 * purpose: Read a true/false field of tool input.
 * @param value: (unknown) The field's value.
 * @param key: (string) Field name, for the error message.
 * @return: (boolean) The value.
 * @raises invalid when it is not a boolean.
 */
export function booleanField(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw appError("invalid", `${key} must be true or false`);
  return value;
}

/**
 * purpose: Read the `changes` object of an update tool's input.
 * @param input: (Record<string, unknown>) Tool input.
 * @return: (Record<string, unknown>) The changes.
 * @raises invalid when it is not an object.
 */
export function changesOf(input: Record<string, unknown>): Record<string, unknown> {
  const changes = input.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw appError("invalid", "changes must be an object");
  }
  return changes as Record<string, unknown>;
}

/**
 * purpose: Refuse any key of tool input that the tool does not take.
 * @param fields: (Record<string, unknown>) Tool input, or its changes.
 * @param allowed: (readonly string[]) The keys it may carry.
 * @return: (void)
 * @raises invalid naming the first unknown key.
 */
export function rejectUnknownKeys(
  fields: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw appError("invalid", `Unknown field ${unknown}`);
}

/**
 * purpose: Read an id of one table from tool input.
 * @param ctx: (MutationCtx) Context (to normalize the id).
 * @param table: (T) The table the id must belong to.
 * @param value: (unknown) The field's value.
 * @param key: (string) Field name, for the error message (e.g. "task_id").
 * @param source: (string) Where the model finds valid ids, for the error message.
 * @return: (Id<T>) The id. It is only shaped as an id of the table here; whether the row exists
 *          and belongs to the request's household is the core's check.
 * @raises invalid when missing or not an id of that table.
 */
export function idField<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  value: unknown,
  key: string,
  source: string,
): Id<T> {
  const id = ctx.db.normalizeId(table, stringField(value, key));
  if (id === null) {
    throw appError(
      "invalid",
      `${key} is not a valid ${key.replace("_id", "")} id; use a ${key} from ${source}`,
    );
  }
  return id;
}
