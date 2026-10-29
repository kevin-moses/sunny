// apns.ts
// STUB: Part A (the APNs sender) replaces this file at merge. It exists only so the delivery
// code (delivery.ts) compiles and is tested against the agreed contract:
//   internal.apns.send({ tokens, title, body, data? }) -> one result per token; throws only
//   for configuration ("APNs is not configured...").
// Token cleanup is internal.apnsTokens.deleteTokens, a separate file: a "use node" file can
// only export actions. This stub reports every token as sent.
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/** The result for one device token. */
export interface ApnsResult {
  token: string;
  outcome: "sent" | "unregistered" | "failed";
  status: number;
  reason: string | null;
  retryable: boolean;
}

/**
 * purpose: STUB of the APNs send: reports every token as sent.
 * @param tokens: (string[]) Device tokens.
 * @param title: (string) Notification title.
 * @param body: (string) Notification body.
 * @param data: (Record<string, string>, optional) Custom payload.
 * @return: (ApnsResult[]) One result per token.
 */
export const send = internalAction({
  args: {
    tokens: v.array(v.string()),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (_ctx, args): Promise<ApnsResult[]> => {
    return args.tokens.map((token) => ({
      token,
      outcome: "sent" as const,
      status: 200,
      reason: null,
      retryable: false,
    }));
  },
});
