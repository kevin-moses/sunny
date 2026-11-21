import { APIConnectionError, APIError, TypeSafeError } from "@typesafe-ai/sdk";
import { googleFailure } from "./googleGrant";
import type { GoogleFailure } from "./googleGrant";
import { JevAnswerError, JevNotConfigured } from "./jevClient";

const RETRYABLE_JEV_STATUSES = new Set([408, 429]);
const REJECTED_KEY_STATUSES = new Set([401, 403]);

function jevFailure(e: unknown): GoogleFailure | null {
  if (e instanceof JevNotConfigured) return { kind: "hold", service: "jev" };
  if (e instanceof JevAnswerError) return { kind: "permanent" };
  if (e instanceof APIError) {
    if (REJECTED_KEY_STATUSES.has(e.status)) return { kind: "hold", service: "jev" };
    return e.status < 500 && !RETRYABLE_JEV_STATUSES.has(e.status)
      ? { kind: "permanent" }
      : { kind: "retry" };
  }
  if (e instanceof TypeSafeError && !(e instanceof APIConnectionError)) {
    return { kind: "permanent" };
  }
  return null;
}

export function mailFailure(e: unknown): GoogleFailure {
  return jevFailure(e) ?? googleFailure(e, "mailboxes") ?? { kind: "retry" };
}
