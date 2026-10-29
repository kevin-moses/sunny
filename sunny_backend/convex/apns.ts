"use node";
// apns.ts
// Purpose: Apple Push Notification sender. APNs only accepts HTTP/2, which fetch does not speak
// in Convex, so this "use node" file uses node:http2: one session per send call, reused for all
// tokens, closed at the end, with a 10 second timeout per request. Payload, headers, provider
// token and outcome mapping live in lib/apnsPayload.ts. Nothing is thrown for a push: per-token
// failures and a missing or invalid configuration (configError, message starts with "APNs is
// not configured") are returned. The companion deleteTokens mutation is in apnsTokens.ts
// because a "use node" file may only hold actions.
// Exports: send (internalAction).
//
// Last modified: 2026-10-29

import { connect } from "node:http2";
import type { ClientHttp2Session } from "node:http2";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
  apnsHost,
  buildHeaders,
  buildPayload,
  failureResult,
  getProviderToken,
  loadApnsConfig,
  mapOutcome,
} from "./lib/apnsPayload";
import { ConfigError } from "./lib/errors";
import type { ApnsConfig, ApnsResult, ApnsSendResult } from "./lib/apnsPayload";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * purpose: Send one push on an open session and map the response.
 * @param session: (ClientHttp2Session) Open session.
 * @param config: (ApnsConfig) Configuration.
 * @param providerToken: (string) Provider JWT.
 * @param token: (string) Device token.
 * @param body: (string) Serialized payload.
 * @param data: (Record<string, string> | undefined) Custom keys, for the collapse id.
 * @return: (Promise<ApnsResult>) Result; never rejects.
 */
function sendOne(
  session: ClientHttp2Session,
  config: ApnsConfig,
  providerToken: string,
  token: string,
  body: string,
  data: Record<string, string> | undefined,
): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ApnsResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const headers = buildHeaders(config, providerToken, data, Math.floor(Date.now() / 1000));
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        ...headers,
      });
      let status = 0;
      let text = "";
      req.setEncoding("utf8");
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        finish(failureResult(token, "Timeout"));
        req.close();
      });
      req.on("response", (h) => {
        status = Number(h[":status"] ?? 0);
      });
      req.on("data", (chunk: string) => {
        text += chunk;
      });
      req.on("end", () => {
        let reason: string | null = null;
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? null;
        } catch {
          // An empty body (200) or a non-JSON body leaves the reason null.
        }
        finish(mapOutcome(token, status, reason));
      });
      req.on("error", (e: Error) => finish(failureResult(token, e.message)));
      req.end(body);
    } catch (e) {
      finish(failureResult(token, e instanceof Error ? e.message : "Request failed"));
    }
  });
}

/**
 * purpose: Send an alert push to device tokens over one HTTP/2 session.
 * @param tokens: (string[]) Raw APNs device tokens.
 * @param title: (string) Alert title.
 * @param body: (string) Alert body.
 * @param data: (Record<string, string>) Optional custom keys (snake_case), e.g. task_instance_id.
 * @return: (ApnsSendResult) One result per token, in order, or configError when the key, team id
 *          or key text is missing or invalid.
 */
export const send = internalAction({
  args: {
    tokens: v.array(v.string()),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (_ctx, args): Promise<ApnsSendResult> => {
    let config: ApnsConfig;
    let providerToken: string;
    try {
      config = loadApnsConfig();
      providerToken = await getProviderToken(config, Math.floor(Date.now() / 1000));
    } catch (e) {
      if (e instanceof ConfigError) return { results: [], configError: e.message };
      throw e;
    }
    if (args.tokens.length === 0) return { results: [] };
    const payload = buildPayload(args.title, args.body, args.data);
    const session = connect(`https://${apnsHost(config.environment)}`);
    // A session-level error also surfaces on each pending request's own error event.
    session.on("error", () => {});
    try {
      const results = await Promise.all(
        args.tokens.map((t) => sendOne(session, config, providerToken, t, payload, args.data)),
      );
      return { results };
    } finally {
      session.close();
    }
  },
});
