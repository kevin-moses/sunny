"use node";

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
  isValidDeviceToken,
  loadApnsConfig,
  mapOutcome,
} from "./lib/apnsPayload";
import { ConfigError } from "./lib/errors";
import { parseJsonObject } from "./lib/http";
import type { ApnsConfig, ApnsResult, ApnsSendResult } from "./lib/apnsPayload";

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

function apnsReason(responseBody: string): string | null {
  const reason = parseJsonObject(responseBody)?.reason;
  return typeof reason === "string" ? reason : null;
}

function sendOne(
  session: ClientHttp2Session,
  config: ApnsConfig,
  providerToken: string,
  token: string,
  body: string,
  data: Record<string, string> | undefined,
): Promise<ApnsResult> {
  return new Promise((resolve) => {
    if (!isValidDeviceToken(token)) {
      resolve({ token, outcome: "failed", status: 0, reason: "InvalidToken", retryable: false });
      return;
    }
    let settled = false;
    const finish = (result: ApnsResult): void => {
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
        finish(mapOutcome(token, status, apnsReason(text)));
      });
      req.on("error", (e: Error) => finish(failureResult(token, e.message)));
      req.on("close", () => finish(failureResult(token, "Closed")));
      req.end(body);
    } catch (e) {
      finish(failureResult(token, e instanceof Error ? e.message : "Request failed"));
    }
  });
}

export const send = internalAction({
  args: {
    tokens: v.array(v.string()),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.record(v.string(), v.string())),
    interruptionLevel: v.optional(v.literal("time-sensitive")),
    category: v.optional(v.string()),
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
    const payload = buildPayload(args.title, args.body, args.data, {
      interruptionLevel: args.interruptionLevel,
      category: args.category,
    });
    const session = connect(`https://${apnsHost(config.environment)}`);
    session.on("error", () => {});
    const connectTimer = setTimeout(
      () => session.destroy(new Error("connect timeout")),
      CONNECT_TIMEOUT_MS,
    );
    session.once("connect", () => clearTimeout(connectTimer));
    let broken = false;
    try {
      const results = await Promise.all(
        args.tokens.map((t) => sendOne(session, config, providerToken, t, payload, args.data)),
      );
      broken = results.some((r) => r.outcome === "failed" && r.retryable);
      for (const r of results) {
        if (r.outcome === "failed")
          console.error(`apns: ${r.token.slice(0, 8)} ${r.status} ${r.reason}`);
      }
      return { results };
    } finally {
      clearTimeout(connectTimer);
      if (broken) session.destroy();
      else session.close();
    }
  },
});
