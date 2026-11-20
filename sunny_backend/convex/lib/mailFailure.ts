import { APIConnectionError, APIError, TypeSafeError } from "@typesafe-ai/sdk";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { recordLostGrant } from "../googleGrant";
import { googleFailure } from "./googleGrant";
import type { GoogleFailure } from "./googleGrant";
import { JevAnswerError } from "./mailJudge";

const RETRYABLE_JEV_STATUSES = new Set([408, 429]);
const REJECTED_KEY_STATUSES = new Set([401, 403]);

function classify(e: unknown): GoogleFailure {
  const google = googleFailure(e, "mailboxes");
  if (google !== null) return google;
  if (e instanceof JevAnswerError) return { kind: "permanent" };
  if (e instanceof APIError) {
    if (REJECTED_KEY_STATUSES.has(e.status)) return { kind: "setup" };
    return e.status < 500 && !RETRYABLE_JEV_STATUSES.has(e.status)
      ? { kind: "permanent" }
      : { kind: "retry" };
  }
  if (e instanceof TypeSafeError && !(e instanceof APIConnectionError)) {
    return { kind: "permanent" };
  }
  return { kind: "retry" };
}

export async function mailFailure(
  ctx: ActionCtx,
  mailboxId: Id<"mailboxes">,
  refreshToken: string,
  e: unknown,
): Promise<GoogleFailure> {
  const failure = classify(e);
  if (failure.kind === "grant") {
    await recordLostGrant(ctx, { table: "mailboxes", id: mailboxId }, refreshToken, failure);
  }
  return failure;
}
