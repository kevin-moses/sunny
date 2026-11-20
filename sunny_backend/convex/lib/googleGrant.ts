import { ConfigError } from "./errors";
import { GoogleAccessRevoked, GoogleApiError } from "./google";
import { SecretUnreadable } from "./secretBox";

export type GrantTable = "mailboxes" | "calendarConnections";

export type GrantStatus = "revoked" | "error";

interface GrantMessages {
  revoked: string;
  unreadable: string;
  forbidden: string;
}

const GRANT_MESSAGES: Record<GrantTable, GrantMessages> = {
  mailboxes: {
    revoked: "Google access was revoked; reconnect the senior's Gmail.",
    unreadable: "Reconnect Gmail: Sunny could not read the saved Google sign-in.",
    forbidden: "Google denied Sunny access to the mailbox; reconnect Gmail.",
  },
  calendarConnections: {
    revoked: "Google access was revoked; reconnect Google Calendar.",
    unreadable: "Reconnect Google Calendar: Sunny could not read the saved Google sign-in.",
    forbidden: "Google denied Sunny access to the Sunny calendar; reconnect Google Calendar.",
  },
};

export type GoogleFailure =
  | { kind: "grant"; status: GrantStatus; error: string }
  | { kind: "setup" }
  | { kind: "permanent" }
  | { kind: "retry" };

export function googleFailure(e: unknown, table: GrantTable): GoogleFailure | null {
  const messages = GRANT_MESSAGES[table];
  if (e instanceof SecretUnreadable) {
    return { kind: "grant", status: "error", error: messages.unreadable };
  }
  if (e instanceof GoogleAccessRevoked) {
    return { kind: "grant", status: "revoked", error: messages.revoked };
  }
  if (e instanceof ConfigError) return { kind: "setup" };
  if (!(e instanceof GoogleApiError)) return null;
  if (e.status === 403 && !e.retryable) {
    return { kind: "grant", status: "error", error: messages.forbidden };
  }
  return !e.retryable && e.status !== 401 ? { kind: "permanent" } : { kind: "retry" };
}
