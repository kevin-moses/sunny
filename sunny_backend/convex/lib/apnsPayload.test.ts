// lib/apnsPayload.test.ts
// Purpose: Tests for the pure APNs helpers: configuration loading and errors, host selection,
// payload and header building, ES256 provider token header, claims and signature (verified with
// the matching public key), PEM handling (literal "\n" escapes, bad PEM), the 50 minute cache
// window, and outcome mapping for each status and reason.
//
// Last modified: 2026-10-29

import { beforeEach, describe, expect, test } from "vitest";
import { fromBase64Url } from "./base64";
import {
  apnsHost,
  buildHeaders,
  buildPayload,
  getProviderToken,
  jwtClaims,
  loadApnsConfig,
  mapOutcome,
  resetProviderTokenCache,
  signProviderToken,
} from "./apnsPayload";
import type { ApnsConfig } from "./apnsPayload";

/**
 * purpose: Generate a P-256 key pair and the private key as PKCS8 PEM.
 * @return: (Promise<{ pem: string; publicKey: CryptoKey }>) PEM and verification key.
 */
async function makeKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

let pem = "";
let publicKey: CryptoKey;

beforeEach(async () => {
  resetProviderTokenCache();
  if (!pem) ({ pem, publicKey } = await makeKey());
});

/**
 * purpose: A valid configuration using the generated key.
 * @return: (ApnsConfig) Config.
 */
function config(): ApnsConfig {
  return {
    keyId: "KID123",
    teamId: "TEAM456",
    keyPem: pem,
    bundleId: "com.kmsunny.sunny",
    environment: "development",
  };
}

describe("loadApnsConfig", () => {
  test("defaults to development and the app bundle id", () => {
    const c = loadApnsConfig({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_KEY_P8: "p" });
    expect(c.environment).toBe("development");
    expect(c.bundleId).toBe("com.kmsunny.sunny");
  });

  test("accepts production and a custom bundle id", () => {
    const c = loadApnsConfig({
      APNS_KEY_ID: "k",
      APNS_TEAM_ID: "t",
      APNS_KEY_P8: "p",
      APNS_ENVIRONMENT: "production",
      APNS_BUNDLE_ID: "com.example.app",
    });
    expect(c.environment).toBe("production");
    expect(c.bundleId).toBe("com.example.app");
  });

  test("converts literal backslash-n escapes in the key to newlines", () => {
    const c = loadApnsConfig({
      APNS_KEY_ID: "k",
      APNS_TEAM_ID: "t",
      APNS_KEY_P8: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    });
    expect(c.keyPem).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  test.each([
    ["APNS_KEY_ID", { APNS_TEAM_ID: "t", APNS_KEY_P8: "p" }],
    ["APNS_TEAM_ID", { APNS_KEY_ID: "k", APNS_KEY_P8: "p" }],
    ["APNS_KEY_P8", { APNS_KEY_ID: "k", APNS_TEAM_ID: "t" }],
  ])("throws a recognisable error when %s is missing", (name, env) => {
    expect(() => loadApnsConfig(env)).toThrow(`APNs is not configured: ${name} is missing`);
  });

  test("throws for an unknown environment", () => {
    expect(() =>
      loadApnsConfig({
        APNS_KEY_ID: "k",
        APNS_TEAM_ID: "t",
        APNS_KEY_P8: "p",
        APNS_ENVIRONMENT: "staging",
      }),
    ).toThrow(/APNs is not configured/);
  });
});

describe("apnsHost", () => {
  test("selects the sandbox and production hosts", () => {
    expect(apnsHost("development")).toBe("api.sandbox.push.apple.com");
    expect(apnsHost("production")).toBe("api.push.apple.com");
  });
});

describe("buildPayload", () => {
  test("wraps title and body in aps with the default sound", () => {
    expect(JSON.parse(buildPayload("T", "B"))).toEqual({
      aps: { alert: { title: "T", body: "B" }, sound: "default" },
    });
  });

  test("keeps snake_case data keys at the top level", () => {
    const p = JSON.parse(buildPayload("T", "B", { task_instance_id: "abc" }));
    expect(p.task_instance_id).toBe("abc");
    expect(p.aps.alert.title).toBe("T");
  });

  test("data cannot override aps", () => {
    const p = JSON.parse(buildPayload("T", "B", { aps: "evil" }));
    expect(p.aps.alert).toEqual({ title: "T", body: "B" });
  });
});

describe("buildHeaders", () => {
  test("sets topic, push type, priority, expiration and authorization", () => {
    const h = buildHeaders(config(), "jwt", undefined, 1000);
    expect(h).toMatchObject({
      authorization: "bearer jwt",
      "apns-topic": "com.kmsunny.sunny",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(1000 + 3 * 3600),
    });
    expect(h["apns-collapse-id"]).toBeUndefined();
  });

  test("uses task_instance_id as the collapse id, capped at 64 bytes", () => {
    expect(buildHeaders(config(), "j", { task_instance_id: "abc" }, 0)["apns-collapse-id"]).toBe(
      "abc",
    );
    const long = "x".repeat(100);
    const h = buildHeaders(config(), "j", { task_instance_id: long }, 0);
    expect(h["apns-collapse-id"]).toHaveLength(64);
  });
});

describe("provider token", () => {
  test("claims carry iss and iat", () => {
    expect(jwtClaims("TEAM", 42)).toEqual({ iss: "TEAM", iat: 42 });
  });

  test("header, claims and signature verify against the public key", async () => {
    const jwt = await signProviderToken(config(), 1234);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    const dec = (x: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(x)));
    expect(dec(h)).toEqual({ alg: "ES256", kid: "KID123" });
    expect(dec(c)).toEqual({ iss: "TEAM456", iat: 1234 });
    const sig = fromBase64Url(s);
    expect(sig).toHaveLength(64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sig,
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  test("signs with a key supplied using literal backslash-n escapes", async () => {
    const escaped = loadApnsConfig({
      APNS_KEY_ID: "k",
      APNS_TEAM_ID: "t",
      APNS_KEY_P8: pem.replace(/\n/g, "\\n"),
    });
    expect((await signProviderToken(escaped, 1)).split(".")).toHaveLength(3);
  });

  test("rejects text that is not a PEM key", async () => {
    await expect(signProviderToken({ ...config(), keyPem: "nope" }, 1)).rejects.toThrow(
      /APNs is not configured/,
    );
  });

  test("rejects a PEM whose contents are not a P-256 key", async () => {
    const bad = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    await expect(signProviderToken({ ...config(), keyPem: bad }, 1)).rejects.toThrow(
      /APNs is not configured/,
    );
  });

  test("is cached inside the 50 minute window and refreshed after it", async () => {
    const first = await getProviderToken(config(), 1000);
    expect(await getProviderToken(config(), 1000 + 49 * 60)).toBe(first);
    const refreshed = await getProviderToken(config(), 1000 + 50 * 60);
    expect(refreshed).not.toBe(first);
    expect(JSON.parse(atob(refreshed.split(".")[1]!)).iat).toBe(1000 + 50 * 60);
  });

  test("is re-signed when the key id changes", async () => {
    const first = await getProviderToken(config(), 1000);
    const other = await getProviderToken({ ...config(), keyId: "OTHER" }, 1001);
    expect(other).not.toBe(first);
  });
});

describe("mapOutcome", () => {
  test("200 is sent", () => {
    expect(mapOutcome("t", 200, null)).toEqual({
      token: "t",
      outcome: "sent",
      status: 200,
      reason: null,
      retryable: false,
    });
  });

  test.each([
    [410, "Unregistered"],
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
  ])("%i %s is unregistered and not retryable", (status, reason) => {
    expect(mapOutcome("t", status, reason)).toMatchObject({
      outcome: "unregistered",
      retryable: false,
      reason,
    });
  });

  test.each([429, 500, 503])("%i is a retryable failure", (status) => {
    expect(mapOutcome("t", status, "X")).toMatchObject({ outcome: "failed", retryable: true });
  });

  test.each([
    [400, "PayloadEmpty"],
    [403, "InvalidProviderToken"],
    [413, "PayloadTooLarge"],
  ])("%i %s is a permanent failure", (status, reason) => {
    expect(mapOutcome("t", status, reason)).toMatchObject({
      outcome: "failed",
      retryable: false,
      reason,
    });
  });
});
