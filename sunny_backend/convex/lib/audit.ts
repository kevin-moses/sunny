import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { actorUserId } from "./access";
import type { Actor } from "./access";

export interface AuditEntry {
  householdId: Id<"households">;
  actor: Actor;
  action: string;
  entity: string;
  entityId?: string;
  detail: Record<string, unknown>;
}

function requestIdDetail(entry: AuditEntry): Record<string, unknown> {
  const { actor, detail } = entry;
  return actor.kind === "agent" && actor.requestId
    ? { ...detail, requestId: actor.requestId }
    : detail;
}

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
