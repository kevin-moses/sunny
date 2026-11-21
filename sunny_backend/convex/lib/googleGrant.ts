import { ConfigError } from "./errors";
import { GoogleAccessRevoked, GoogleApiError } from "./google";
import { SecretUnreadable } from "./secretBox";

export type GrantStatus = "revoked" | "error";

export type LostGrant = "revoked" | "unreadable" | "forbidden";

export type GoogleCause = LostGrant | "hold" | "permanent" | "retry";

export const LOST_GRANT_STATUS: Record<LostGrant, GrantStatus> = {
  revoked: "revoked",
  unreadable: "error",
  forbidden: "error",
};

export function googleFailure(e: unknown): GoogleCause | null {
  if (e instanceof SecretUnreadable) return "unreadable";
  if (e instanceof GoogleAccessRevoked) return "revoked";
  if (e instanceof ConfigError) return "hold";
  if (!(e instanceof GoogleApiError)) return null;
  if (e.projectWide) return "hold";
  if (e.status === 403 && !e.retryable) return "forbidden";
  return !e.retryable && e.status !== 401 ? "permanent" : "retry";
}
