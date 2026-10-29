// apns.test.ts
// Purpose: Tests for the APNs sender with node:http2 mocked (Apple is never called): one session
// reused across tokens and closed afterwards, host and request headers, payload body, per-token
// outcomes (sent, unregistered, retryable and permanent failures), timeouts and connection
// errors as retryable failures, empty token list, and configuration errors. Also covers the
// deleteTokens mutation from apnsTokens.ts with convex-test.
//
// Last modified: 2026-10-29

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { resetProviderTokenCache } from "./lib/apnsPayload";

/** One scripted response for a fake request. */
type Script = { status?: number; body?: string; error?: string; hang?: boolean };

const state = vi.hoisted(() => ({
  scripts: [] as unknown[],
  sessions: [] as {
    url: string;
    closed: boolean;
    requests: { headers: unknown; body: string }[];
  }[],
}));

vi.mock("node:http2", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    connect: (url: string) => {
      const session = Object.assign(new Emitter(), {
        info: { url, closed: false, requests: [] as { headers: unknown; body: string }[] },
        close() {
          this.info.closed = true;
        },
        request(headers: unknown) {
          const script = (state.scripts.shift() ?? { status: 200 }) as Script;
          const req = Object.assign(new Emitter(), {
            setEncoding() {},
            setTimeout(_ms: number, cb: () => void) {
              if (script.hang) setTimeout(cb, 0);
            },
            close() {},
            end(body: string) {
              session.info.requests.push({ headers, body });
              if (script.hang) return;
              setTimeout(() => {
                if (script.error) return req.emit("error", new Error(script.error));
                req.emit("response", { ":status": script.status });
                if (script.body) req.emit("data", script.body);
                req.emit("end");
              }, 0);
            },
          });
          return req;
        },
      });
      state.sessions.push(session.info);
      return session;
    },
  };
});

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.helpers.ts"]);

/**
 * purpose: Set the APNs environment variables with a freshly generated key.
 * @param overrides: (Record<string, string | undefined>) Variables to override or unset.
 * @return: (Promise<void>)
 */
async function setEnv(overrides: Record<string, string | undefined> = {}): Promise<void> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  const env: Record<string, string | undefined> = {
    APNS_KEY_ID: "KID",
    APNS_TEAM_ID: "TEAM",
    APNS_KEY_P8: pem,
    APNS_BUNDLE_ID: undefined,
    APNS_ENVIRONMENT: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  state.scripts = [];
  state.sessions = [];
  resetProviderTokenCache();
  await setEnv();
});

/**
 * purpose: Run internal.apns.send.
 * @param tokens: (string[]) Device tokens.
 * @param data: (Record<string, string>) Optional custom keys.
 * @return: (Promise<unknown>) The action result.
 */
async function run(tokens: string[], data?: Record<string, string>) {
  const t = convexTest(schema, modules);
  return await t.action(internal.apns.send, { tokens, title: "Title", body: "Body", data });
}

describe("apns.send", () => {
  test("sends with the expected host, headers and payload", async () => {
    const res = await run(["tok1"], { task_instance_id: "inst1" });
    expect(res).toEqual([
      { token: "tok1", outcome: "sent", status: 200, reason: null, retryable: false },
    ]);
    const session = state.sessions[0]!;
    expect(session.url).toBe("https://api.sandbox.push.apple.com");
    const req = session.requests[0]!;
    expect(req.headers).toMatchObject({
      ":method": "POST",
      ":path": "/3/device/tok1",
      "apns-topic": "com.kmsunny.sunny",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "inst1",
    });
    expect(JSON.parse(req.body)).toEqual({
      task_instance_id: "inst1",
      aps: { alert: { title: "Title", body: "Body" }, sound: "default" },
    });
  });

  test("uses the production host when configured", async () => {
    await setEnv({ APNS_ENVIRONMENT: "production" });
    await run(["tok1"]);
    expect(state.sessions[0]!.url).toBe("https://api.push.apple.com");
  });

  test("reuses one session for all tokens and closes it", async () => {
    await run(["a", "b", "c"]);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.requests).toHaveLength(3);
    expect(state.sessions[0]!.closed).toBe(true);
  });

  test("returns one result per token with mixed outcomes", async () => {
    state.scripts = [
      { status: 200 },
      { status: 410, body: JSON.stringify({ reason: "Unregistered" }) },
      { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) },
      { status: 503, body: JSON.stringify({ reason: "ServiceUnavailable" }) },
      { status: 403, body: JSON.stringify({ reason: "InvalidProviderToken" }) },
    ];
    const res = (await run(["a", "b", "c", "d", "e"])) as {
      token: string;
      outcome: string;
      retryable: boolean;
      reason: string | null;
    }[];
    expect(res.map((r) => [r.token, r.outcome, r.retryable, r.reason])).toEqual([
      ["a", "sent", false, null],
      ["b", "unregistered", false, "Unregistered"],
      ["c", "unregistered", false, "BadDeviceToken"],
      ["d", "failed", true, "ServiceUnavailable"],
      ["e", "failed", false, "InvalidProviderToken"],
    ]);
  });

  test("a timeout is a retryable failure and does not affect other tokens", async () => {
    state.scripts = [{ hang: true }, { status: 200 }];
    const res = (await run(["slow", "ok"])) as {
      outcome: string;
      retryable: boolean;
      reason: string | null;
    }[];
    expect(res[0]!).toMatchObject({
      outcome: "failed",
      retryable: true,
      reason: "Timeout",
      status: 0,
    });
    expect(res[1]!.outcome).toBe("sent");
  });

  test("a connection error is a retryable failure", async () => {
    state.scripts = [{ error: "ECONNRESET" }];
    const res = (await run(["a"])) as {
      outcome: string;
      retryable: boolean;
      reason: string | null;
    }[];
    expect(res[0]!).toMatchObject({ outcome: "failed", retryable: true, reason: "ECONNRESET" });
  });

  test("an empty token list opens no session", async () => {
    expect(await run([])).toEqual([]);
    expect(state.sessions).toHaveLength(0);
  });

  test.each(["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY_P8"])(
    "throws a recognisable config error when %s is missing",
    async (name) => {
      await setEnv({ [name]: undefined });
      await expect(run(["a"])).rejects.toThrow("APNs is not configured");
      expect(state.sessions).toHaveLength(0);
    },
  );

  test("throws a config error for a bad PEM", async () => {
    await setEnv({ APNS_KEY_P8: "not a pem" });
    await expect(run(["a"])).rejects.toThrow("APNs is not configured");
  });
});

describe("apnsTokens.deleteTokens", () => {
  test("deletes the listed tokens only and ignores unknown ones", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("pushTokens", { userId: "u1", token: "a" });
      await ctx.db.insert("pushTokens", { userId: "u1", token: "b" });
      await ctx.db.insert("pushTokens", { userId: "u2", token: "c" });
    });
    const deleted = await t.mutation(internal.apnsTokens.deleteTokens, {
      tokens: ["a", "c", "a", "missing"],
    });
    expect(deleted).toBe(2);
    const left = await t.run(async (ctx) =>
      (await ctx.db.query("pushTokens").collect()).map((r) => r.token),
    );
    expect(left).toEqual(["b"]);
  });
});
