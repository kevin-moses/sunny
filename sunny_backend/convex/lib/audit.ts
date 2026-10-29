// lib/audit.ts
// Purpose: Writes audit log rows, replacing the Postgres audit triggers. Called from the
// mutations that change audited tables. The actor kind and user id come from the Actor;
// agent and system actors have no user id.
//
// Last modified: 2026-10-28

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
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
 * purpose: Append a row to the audit log.
 * @param ctx: (MutationCtx) Mutation context.
 * @param entry: (AuditEntry) Household, actor, action, entity and detail to record.
 * @return: (Promise<void>) Resolves when the row is written.
 */
export async function audit(ctx: MutationCtx, entry: AuditEntry): Promise<void> {
  const { actor } = entry;
  await ctx.db.insert("auditLog", {
    householdId: entry.householdId,
    actorUserId: "userId" in actor ? actor.userId : undefined,
    actorKind: actor.kind,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    detail: entry.detail,
  });
}
