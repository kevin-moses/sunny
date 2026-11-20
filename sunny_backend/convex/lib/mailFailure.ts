import { APIConnectionError, APIError, TypeSafeError } from "@typesafe-ai/sdk";
import { googleFailure } from "./googleGrant";
import type { GoogleFailure } from "./googleGrant";
import { JevAnswerError } from "./jevClient";

const RETRYABLE_JEV_STATUSES = new Set([408, 429]);
const REJECTED_KEY_STATUSES = new Set([401, 403]);

export function mailFailure(e: unknown): GoogleFailure {
  const google = googleFailure(e, "mailboxes");
  if (google !== null) return google;
  if (e instanceof JevAnswerError) return { kind: "permanent" };
  if (e instanceof APIError) {
    if (REJECTED_KEY_STATUSES.has(e.status)) return { kind: "hold" };
    return e.status < 500 && !RETRYABLE_JEV_STATUSES.has(e.status)
      ? { kind: "permanent" }
      : { kind: "retry" };
  }
  if (e instanceof TypeSafeError && !(e instanceof APIConnectionError)) {
    return { kind: "permanent" };
  }
  return { kind: "retry" };
}
