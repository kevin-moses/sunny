import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AgentActor } from "./access";
import { appError } from "./errors";
import { requireNonBlank } from "./text";

export interface ToolContext {
  householdId: Id<"households">;
  actor: AgentActor;
  now: number;
}

export type ToolHandler = (
  ctx: MutationCtx,
  toolCtx: ToolContext,
  input: Record<string, unknown>,
) => Promise<unknown>;

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

export function optionalString(value: unknown, key: string): string | undefined {
  return value === undefined ? undefined : stringField(value, key);
}

export function booleanField(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw appError("invalid", `${key} must be true or false`);
  return value;
}

export function changesOf(input: Record<string, unknown>): Record<string, unknown> {
  const changes = input.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw appError("invalid", "changes must be an object");
  }
  return changes as Record<string, unknown>;
}

export function rejectUnknownKeys(
  fields: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw appError("invalid", `Unknown field ${unknown}`);
}

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
