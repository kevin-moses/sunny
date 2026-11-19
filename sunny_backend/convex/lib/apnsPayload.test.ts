import { beforeEach, describe, expect, test } from "vitest";
import { fromBase64Url } from "./base64";
import {
  alertMessage,
  apnsHost,
  backgroundRefreshMessage,
  CAREGIVER_ALERT_CATEGORY,
  isValidDeviceToken,
  pushStyle,
  buildHeaders,
  getProviderToken,
  jwtClaims,
  loadApnsConfig,
  mapOutcome,
  resetProviderTokenCache,
  signProviderToken,
} from "./apnsPayload";
import type { ApnsConfig, PushStyle } from "./apnsPayload";

function alertBody(
  title: string,
  body: string,
  data?: Record<string, string>,
  style: PushStyle = {},
): string {
  return alertMessage(title, body, data, style, 1000).body;
}

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
  test("defaults to the app bundle id", () => {
    const c = loadApnsConfig({
      APNS_KEY_ID: "k",
      APNS_TEAM_ID: "t",
      APNS_KEY_P8: "p",
      APNS_ENVIRONMENT: "development",
    });
    expect(c.environment).toBe("development");
    expect(c.bundleId).toBe("com.kmsunny.sunny");
  });

  test("throws when the environment is not set", () => {
    expect(() => loadApnsConfig({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_KEY_P8: "p" })).toThrow(
      /APNs is not configured: APNS_ENVIRONMENT/,
    );
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
      APNS_ENVIRONMENT: "development",
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

describe("alertMessage body", () => {
  test("wraps title and body in aps with the default sound", () => {
    expect(JSON.parse(alertBody("T", "B"))).toEqual({
      aps: { alert: { title: "T", body: "B" }, sound: "default" },
    });
  });

  test("keeps snake_case data keys at the top level", () => {
    const p = JSON.parse(alertBody("T", "B", { task_instance_id: "abc" }));
    expect(p.task_instance_id).toBe("abc");
    expect(p.aps.alert.title).toBe("T");
  });

  test("data cannot override aps", () => {
    const p = JSON.parse(alertBody("T", "B", { aps: "evil" }));
    expect(p.aps.alert).toEqual({ title: "T", body: "B" });
  });

  test("a style adds interruption-level and category inside aps, data stays outside", () => {
    const style = { interruptionLevel: "time-sensitive" as const, category: "caregiver_alert" };
    const p = JSON.parse(alertBody("T", "B", { kind: "caregiver_alert" }, style));
    expect(p).toEqual({
      kind: "caregiver_alert",
      aps: {
        alert: { title: "T", body: "B" },
        sound: "default",
        "interruption-level": "time-sensitive",
        category: "caregiver_alert",
      },
    });
  });

  test("a long body is still cut under 4 KB with a style", () => {
    const style = { interruptionLevel: "time-sensitive" as const, category: "caregiver_alert" };
    const payload = alertBody("T", "x".repeat(10_000), undefined, style);
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(4096);
    expect(JSON.parse(payload).aps.category).toBe("caregiver_alert");
  });
});

describe("pushStyle", () => {
  const editor = { kind: "caregiver", canClaim: true } as const;
  const viewer = { kind: "caregiver", canClaim: false } as const;
  const device = { kind: "device" } as const;

  test("a caregiver alert to an editor is time-sensitive with the action category", () => {
    expect(pushStyle("caregiver_alert", editor)).toEqual({
      interruptionLevel: "time-sensitive",
      category: CAREGIVER_ALERT_CATEGORY,
    });
    expect(CAREGIVER_ALERT_CATEGORY).toBe("caregiver_alert");
  });

  test("a caregiver alert to a viewer is time-sensitive with no category", () => {
    expect(pushStyle("caregiver_alert", viewer)).toEqual({ interruptionLevel: "time-sensitive" });
  });

  test("an agent flag is time-sensitive for every caregiver, never with a category", () => {
    expect(pushStyle("agent_flag", editor)).toEqual({ interruptionLevel: "time-sensitive" });
    expect(pushStyle("agent_flag", viewer)).toEqual({ interruptionLevel: "time-sensitive" });
  });

  test("a digest, an event notice and a family message are plain for caregivers", () => {
    for (const kind of ["digest", "event_notice", "family_message"] as const) {
      expect(pushStyle(kind, editor)).toEqual({});
    }
  });

  test("a senior prompt to a device is time-sensitive; other device pushes are plain", () => {
    expect(pushStyle("senior_prompt", device)).toEqual({ interruptionLevel: "time-sensitive" });
    for (const kind of ["event_notice", "caregiver_alert", "agent_flag"] as const) {
      expect(pushStyle(kind, device)).toEqual({});
    }
  });
});

describe("device tokens and payload size", () => {
  test("accepts 64 to 200 hex characters only", () => {
    expect(isValidDeviceToken("a".repeat(64))).toBe(true);
    expect(isValidDeviceToken("AB12".repeat(50))).toBe(true);
    expect(isValidDeviceToken("a".repeat(63))).toBe(false);
    expect(isValidDeviceToken("a".repeat(201))).toBe(false);
    expect(isValidDeviceToken(`${"a".repeat(63)}/`)).toBe(false);
    expect(isValidDeviceToken("")).toBe(false);
  });

  test("a long body is cut so the payload stays under 4 KB", () => {
    const payload = alertBody("Title", "x".repeat(10_000), { task_instance_id: "i" });
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(4096);
    expect(JSON.parse(payload).aps.alert.title).toBe("Title");
    expect(JSON.parse(payload).aps.alert.body.length).toBeGreaterThan(2000);
  });

  test("a short body is left alone", () => {
    expect(JSON.parse(alertBody("T", "short")).aps.alert.body).toBe("short");
  });
});

describe("alertMessage headers", () => {
  test("sets topic, push type, priority, expiration and authorization", () => {
    const h = buildHeaders(config(), "jwt", alertMessage("T", "B", undefined, {}, 1000));
    expect(h).toEqual({
      authorization: "bearer jwt",
      "apns-topic": "com.kmsunny.sunny",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(1000 + 3 * 3600),
      "content-type": "application/json",
    });
  });

  test("uses task_instance_id as the collapse id, capped at 64 bytes", () => {
    const collapse = (id: string): string | undefined =>
      buildHeaders(config(), "j", alertMessage("T", "B", { task_instance_id: id }, {}, 0))[
        "apns-collapse-id"
      ];
    expect(collapse("abc")).toBe("abc");
    expect(collapse("x".repeat(100))).toHaveLength(64);
  });

  test("two caregiver alerts about one task share a collapse id; other tasks do not", () => {
    const collapse = (id: string, instance: string): string | undefined =>
      buildHeaders(
        config(),
        "j",
        alertMessage(
          "T",
          "B",
          {
            notification_id: id,
            kind: "caregiver_alert",
            household_id: "h",
            task_instance_id: instance,
          },
          {},
          0,
        ),
      )["apns-collapse-id"];
    expect(collapse("n1", "inst1")).toBe(collapse("n2", "inst1"));
    expect(collapse("n1", "inst1")).not.toBe(collapse("n3", "inst2"));
  });

  test("the topic takes the push type's suffix and the bundle id from the configuration", () => {
    const other = { ...config(), bundleId: "com.example.app" };
    expect(buildHeaders(other, "j", backgroundRefreshMessage())["apns-topic"]).toBe(
      "com.example.app",
    );
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
      APNS_ENVIRONMENT: "development",
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

  test("iat is the start of the 30 minute bucket and the token is reused inside it", async () => {
    const first = await getProviderToken(config(), 3600 + 100);
    expect(JSON.parse(atob(first.split(".")[1]!)).iat).toBe(3600);
    expect(await getProviderToken(config(), 3600 + 1799)).toBe(first);
  });

  test("is re-signed when the bucket changes", async () => {
    const first = await getProviderToken(config(), 3600 + 100);
    const next = await getProviderToken(config(), 3600 + 1800);
    expect(next).not.toBe(first);
    expect(JSON.parse(atob(next.split(".")[1]!)).iat).toBe(3600 + 1800);
  });

  test("two containers signing in the same bucket share claims", async () => {
    const a = await getProviderToken(config(), 7200 + 5);
    resetProviderTokenCache();
    const b = await getProviderToken(config(), 7200 + 1000);
    expect(a.split(".")[1]).toBe(b.split(".")[1]);
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

  test("410 is unregistered and not retryable", () => {
    expect(mapOutcome("t", 410, "Unregistered")).toMatchObject({
      outcome: "unregistered",
      retryable: false,
      reason: "Unregistered",
    });
  });

  test.each([
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
  ])("%i %s is a permanent failure, not an unregistered token", (status, reason) => {
    expect(mapOutcome("t", status, reason)).toMatchObject({
      outcome: "failed",
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
