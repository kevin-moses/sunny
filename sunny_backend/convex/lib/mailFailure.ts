import { APIConnectionError, APIError, TypeSafeError } from "@typesafe-ai/sdk";
import { googleFailure } from "./googleGrant";
import type { GoogleCause } from "./googleGrant";
import { JevAnswerError, JevNotConfigured } from "./jevClient";

const RETRYABLE_JEV_STATUSES = new Set([408, 429]);
const REJECTED_KEY_STATUSES = new Set([401, 403]);

export type MailCause = GoogleCause | "jev_hold";

function jevFailure(e: unknown): MailCause | null {
  if (e instanceof JevNotConfigured) return "jev_hold";
  if (e instanceof JevAnswerError) return "permanent";
  if (e instanceof APIError) {
    if (REJECTED_KEY_STATUSES.has(e.status)) return "jev_hold";
    return e.status < 500 && !RETRYABLE_JEV_STATUSES.has(e.status) ? "permanent" : "retry";
  }
  if (e instanceof TypeSafeError && !(e instanceof APIConnectionError)) return "permanent";
  return null;
}

export function mailFailure(e: unknown): MailCause {
  return jevFailure(e) ?? googleFailure(e) ?? "retry";
}
