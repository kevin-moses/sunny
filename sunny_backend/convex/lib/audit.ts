// lib/audit.ts
// Purpose: Writes audit log rows, replacing the Postgres audit triggers. Called from the
// mutations that change audited tables. The actor kind and user id come from the Actor;
// the household agent's rows record the caregiver it acted for as the user id and its request
// id in detail.requestId; other agent and system actors have no user id.
//
// Last modified: 2026-11-01

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { actorUserId } from "./access";
import type { Actor } from "./access";

/** What to record for one audited change. */
export interface AuditEntry {
  householdId: Id<"households">;
  actor: Actor;
  action: string;
  entity: string;
  entityId?: string;
  detail: Record<string, unknown>;
}

/**
 * purpose: The entry's detail, plus the agent request id when the actor is the household agent.
 * @param entry: (AuditEntry) The entry being recorded.
 * @return: (Record<string, unknown>) The detail to store.
 */
function requestIdDetail(entry: AuditEntry): Record<string, unknown> {
  const { actor, detail } = entry;
  return actor.kind === "agent" && actor.requestId
    ? { ...detail, requestId: actor.requestId }
    : detail;
}

/**
 * purpose: Append a row to the audit log.
 * @param ctx: (MutationCtx) Mutation context.
 * @param entry: (AuditEntry) Household, actor, action, entity and detail to record.
 * @return: (Promise<void>) Resolves when the row is written.
 */
export async function audit(ctx: MutationCtx, entry: AuditEntry): Promise<void> {
  await ctx.db.insert("auditLog", {
    householdId: entry.householdId,
    actorUserId: actorUserId(entry.actor),
    actorKind: entry.actor.kind,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    detail: requestIdDetail(entry),
  });
}
