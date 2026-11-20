import { APIConnectionError, APIError, TypeSafeError } from "@typesafe-ai/sdk";
import { ConfigError } from "./errors";
import { GoogleAccessRevoked, GoogleApiError } from "./google";
import { JevAnswerError } from "./mailJudge";
import { SecretUnreadable } from "./secretBox";

const REVOKED_MESSAGE = "Google access was revoked; reconnect the senior's Gmail.";
const UNREADABLE_MESSAGE = "Reconnect Gmail: Sunny could not read the saved Google sign-in.";
const FORBIDDEN_MESSAGE = "Google denied Sunny access to the mailbox; reconnect Gmail.";
const RETRYABLE_JEV_STATUSES = new Set([408, 429]);
const REJECTED_KEY_STATUSES = new Set([401, 403]);

type MailFailure =
  | { kind: "mailbox"; status: "revoked" | "error"; error: string }
  | { kind: "setup" }
  | { kind: "permanent" }
  | { kind: "retry" };

export function mailFailure(e: unknown): MailFailure {
  if (e instanceof SecretUnreadable) {
    return { kind: "mailbox", status: "error", error: UNREADABLE_MESSAGE };
  }
  if (e instanceof GoogleAccessRevoked) {
    return { kind: "mailbox", status: "revoked", error: REVOKED_MESSAGE };
  }
  if (e instanceof GoogleApiError && e.status === 403 && !e.retryable) {
    return { kind: "mailbox", status: "error", error: FORBIDDEN_MESSAGE };
  }
  if (e instanceof ConfigError) return { kind: "setup" };
  if (e instanceof JevAnswerError) return { kind: "permanent" };
  if (e instanceof GoogleApiError) {
    return !e.retryable && e.status !== 401 ? { kind: "permanent" } : { kind: "retry" };
  }
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
