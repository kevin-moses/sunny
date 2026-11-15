// lib/apnsPayload.ts
// Purpose: Pure helpers for the Apple Push Notification sender (apns.ts), kept free of
// node:http2 so they can be unit tested: configuration from the environment (APNS_KEY_ID,
// APNS_TEAM_ID, APNS_KEY_P8, APNS_ENVIRONMENT which must be set, optional APNS_BUNDLE_ID), host
// selection, device token validation, the alert payload (capped to 4 KB) and request headers,
// the ES256 provider token (signed with an iat from a 30-minute bucket so containers share
// claims, re-signed when the bucket changes), and the mapping from an APNs response to a
// per-token outcome. Configuration problems raise ConfigError ("APNs is not configured").
//
// Presentation per kind and recipient (pushStyle): a caregiver_alert or agent_flag to a
// caregiver, and a senior_prompt to a senior device, carry aps "interruption-level":
// "time-sensitive" (it can break through a Focus; the app needs the
// com.apple.developer.usernotifications.time-sensitive entitlement); every other kind stays at
// the default level ("active", so the key is left out). A caregiver_alert to a caregiver who may
// claim (not a viewer) carries aps "category": "caregiver_alert", the category the caregiver app
// registers with its one "I'm on it" action; a viewer's push has no category. Custom keys
// (notification_id, kind, household_id, task_instance_id) sit beside aps, never inside it (APNs
// ignores custom keys inside aps). The apns-collapse-id header is the task instance id, so a
// later alert about the same task replaces the earlier one on the caregiver's phone (and a
// reprompt replaces the earlier prompt on a senior device).
// The aps keys follow Apple's "Generating a remote notification" (Table 1, keys of the aps
// dictionary: alert, sound, category, interruption-level with "passive", "active",
// "time-sensitive" or "critical"; custom keys as peers of aps; 4 KB payload limit):
// https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification
//
// Exports: APNS_NOT_CONFIGURED, CAREGIVER_ALERT_CATEGORY, ApnsConfig, ApnsOutcome, ApnsResult,
// ApnsSendResult, PushStyle, PushRecipient, pushStyle, loadApnsConfig, apnsHost,
// isValidDeviceToken, buildPayload, buildHeaders, jwtClaims, signProviderToken,
// getProviderToken, resetProviderTokenCache, mapOutcome, failureResult.
//
// Last modified: 2026-11-14

import { fromBase64, toBase64Url } from "./base64";
import { ConfigError } from "./errors";
import type { NotificationKind } from "./validators";

/** Message prefix the caller can recognise as a configuration error. */
export const APNS_NOT_CONFIGURED = "APNs is not configured";

const SANDBOX_HOST = "api.sandbox.push.apple.com";
const PRODUCTION_HOST = "api.push.apple.com";
const DEFAULT_BUNDLE_ID = "com.kmsunny.sunny";
const EXPIRATION_SECONDS = 3 * 60 * 60;
const TOKEN_BUCKET_SECONDS = 30 * 60;

const APNS_COLLAPSE_ID_MAX_BYTES = 64;
const MAX_PAYLOAD_BYTES = 4096;

/**
 * The aps category of a claimable caregiver alert. It must equal CAREGIVER_ALERT_CATEGORY in
 * sunny_app/src/notifications/caregiverPush.ts, which registers it with the "I'm on it" action.
 */
export const CAREGIVER_ALERT_CATEGORY = "caregiver_alert";

/** How a push presents: its interruption level (absent is the default, "active") and category. */
export type PushStyle = {
  interruptionLevel?: "time-sensitive";
  category?: string;
};

/** Who a push goes to: a paired senior device, or a caregiver who may or may not claim tasks. */
export type PushRecipient = { kind: "device" } | { kind: "caregiver"; canClaim: boolean };

/** Kinds that are time-sensitive for a caregiver: an escalated task and a voice agent flag. */
const CAREGIVER_TIME_SENSITIVE: ReadonlySet<NotificationKind> = new Set([
  "caregiver_alert",
  "agent_flag",
]);

/**
 * purpose: The interruption level and category of a push, by kind and recipient. Time-sensitive:
 *          caregiver_alert and agent_flag to a caregiver, senior_prompt to a senior device.
 *          Category: caregiver_alert to a caregiver who may claim it. Everything else is plain.
 * @param kind: (NotificationKind) The outbox row's kind.
 * @param recipient: (PushRecipient) A device, or a caregiver and whether they may claim.
 * @return: (PushStyle) The style; an empty object for a default push.
 */
export function pushStyle(kind: NotificationKind, recipient: PushRecipient): PushStyle {
  const style: PushStyle = {};
  const timeSensitive =
    recipient.kind === "device" ? kind === "senior_prompt" : CAREGIVER_TIME_SENSITIVE.has(kind);
  if (timeSensitive) style.interruptionLevel = "time-sensitive";
  if (recipient.kind === "caregiver" && recipient.canClaim && kind === "caregiver_alert") {
    style.category = CAREGIVER_ALERT_CATEGORY;
  }
  return style;
}

/** Resolved APNs configuration. */
export type ApnsConfig = {
  keyId: string;
  teamId: string;
  keyPem: string;
  bundleId: string;
  environment: "development" | "production";
};

/** Result category for one token. */
export type ApnsOutcome = "sent" | "unregistered" | "failed";

/**
 * What internal.apns.send returns: one result per token, or `configError` (the message, starting
 * "APNs is not configured") with no results when the configuration is missing or invalid. It is
 * returned rather than thrown because an error thrown across an action call loses its class.
 */
export type ApnsSendResult = { results: ApnsResult[]; configError?: string };

/** Per-token result inside an ApnsSendResult. */
export type ApnsResult = {
  token: string;
  outcome: ApnsOutcome;
  status: number;
  reason: string | null;
  retryable: boolean;
};

/**
 * purpose: Read and validate APNs configuration from the environment.
 * @param env: (Record<string, string | undefined>) Environment, defaults to process.env.
 * @return: (ApnsConfig) Resolved configuration.
 * @raises ConfigError when a key id, team id or key is missing, or the environment is invalid.
 */
export function loadApnsConfig(env: Record<string, string | undefined> = process.env): ApnsConfig {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyRaw = env.APNS_KEY_P8?.trim();
  if (!keyId) throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_KEY_ID is missing`);
  if (!teamId) throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_TEAM_ID is missing`);
  if (!keyRaw) throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_KEY_P8 is missing`);
  const environment = (env.APNS_ENVIRONMENT?.trim() ?? "").toLowerCase();
  if (environment !== "development" && environment !== "production") {
    throw new ConfigError(
      `${APNS_NOT_CONFIGURED}: APNS_ENVIRONMENT must be set to "development" or "production"`,
    );
  }
  return {
    keyId,
    teamId,
    keyPem: normalizePem(keyRaw),
    bundleId: env.APNS_BUNDLE_ID?.trim() || DEFAULT_BUNDLE_ID,
    environment,
  };
}

/**
 * purpose: APNs host for an environment.
 * @param environment: ("development" | "production") Target environment.
 * @return: (string) Host name.
 */
export function apnsHost(environment: "development" | "production"): string {
  return environment === "production" ? PRODUCTION_HOST : SANDBOX_HOST;
}

/**
 * purpose: Whether a string looks like an APNs device token (hex, 64 to 200 characters). Checked
 *          before a token is stored and before it becomes part of a request path.
 * @param token: (string) Candidate token.
 * @return: (boolean) True for 64 to 200 hex characters.
 */
export function isValidDeviceToken(token: string): boolean {
  return /^[0-9a-fA-F]{64,200}$/.test(token);
}

/**
 * purpose: Build the JSON body of an alert push. Data keys stay as given (snake_case), sit beside
 *          aps and cannot override it. The style adds aps "interruption-level" and "category"
 *          when set.
 * @param title: (string) Alert title.
 * @param body: (string) Alert body.
 * @param data: (Record<string, string>) Optional custom keys.
 * @param style: (PushStyle) Optional interruption level and category; default plain.
 * @return: (string) Serialized payload, with the body cut so it stays under 4 KB.
 */
export function buildPayload(
  title: string,
  body: string,
  data?: Record<string, string>,
  style: PushStyle = {},
): string {
  const extra: Record<string, string> = {};
  if (style.interruptionLevel !== undefined) extra["interruption-level"] = style.interruptionLevel;
  if (style.category !== undefined) extra["category"] = style.category;
  /**
   * purpose: Serialize the payload with a given alert body.
   * @param text: (string) The alert body.
   * @return: (string) The JSON payload.
   */
  const encode = (text: string): string =>
    JSON.stringify({
      ...data,
      aps: { alert: { title, body: text }, sound: "default", ...extra },
    });
  let text = body;
  let payload = encode(text);
  while (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES && text.length > 0) {
    text = text.slice(0, Math.floor(text.length * 0.8));
    payload = encode(text);
  }
  return payload;
}

/**
 * purpose: Build the request headers (HTTP/2 pseudo headers excluded).
 * @param config: (ApnsConfig) Configuration.
 * @param providerToken: (string) Signed provider JWT.
 * @param data: (Record<string, string>) Optional custom keys; task_instance_id sets collapse id.
 * @param nowSeconds: (number) Current Unix time in seconds.
 * @return: (Record<string, string>) Headers.
 */
export function buildHeaders(
  config: ApnsConfig,
  providerToken: string,
  data: Record<string, string> | undefined,
  nowSeconds: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `bearer ${providerToken}`,
    "apns-topic": config.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(nowSeconds + EXPIRATION_SECONDS),
    "content-type": "application/json",
  };
  const taskId = data?.task_instance_id;
  // APNs limits the collapse id to 64 bytes.
  if (taskId) headers["apns-collapse-id"] = taskId.slice(0, APNS_COLLAPSE_ID_MAX_BYTES);
  return headers;
}

/**
 * purpose: Claims of the provider token.
 * @param teamId: (string) Apple team id (iss).
 * @param nowSeconds: (number) Current Unix time in seconds (iat).
 * @return: ({ iss: string; iat: number }) Claims.
 */
export function jwtClaims(teamId: string, nowSeconds: number): { iss: string; iat: number } {
  return { iss: teamId, iat: nowSeconds };
}

/**
 * purpose: Normalize a .p8 key supplied with literal "\n" escapes or stray whitespace into PEM.
 * @param raw: (string) Key text.
 * @return: (string) PEM text with real newlines.
 */
function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

/**
 * purpose: Decode a PKCS8 PEM private key to DER bytes.
 * @param pem: (string) PEM text.
 * @return: (Uint8Array<ArrayBuffer>) DER bytes.
 * @raises ConfigError when the PEM is malformed.
 */
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (!match) throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_KEY_P8 is not a PEM private key`);
  try {
    return fromBase64((match[1] ?? "").replace(/\s+/g, ""));
  } catch {
    throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_KEY_P8 is not valid base64`);
  }
}

/**
 * purpose: Sign an ES256 provider token (JWS with raw r||s signature).
 * @param config: (ApnsConfig) Configuration.
 * @param nowSeconds: (number) Current Unix time in seconds.
 * @return: (Promise<string>) The compact JWT.
 * @raises ConfigError when the key cannot be imported as an ES256 key.
 */
export async function signProviderToken(config: ApnsConfig, nowSeconds: number): Promise<string> {
  const enc = new TextEncoder();
  const header = toBase64Url(enc.encode(JSON.stringify({ alg: "ES256", kid: config.keyId })));
  const claims = toBase64Url(enc.encode(JSON.stringify(jwtClaims(config.teamId, nowSeconds))));
  const signingInput = `${header}.${claims}`;
  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(config.keyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_KEY_P8 is not a valid P-256 key`);
  }
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

let cached: { cacheKey: string; token: string } | null = null;

/**
 * purpose: The provider token. Its iat is the start of the current 30-minute bucket, so every
 *          container signs identical claims and a token is at most 30 minutes old (APNs rejects
 *          tokens older than an hour and throttles refreshes more often than every 20 minutes).
 *          The signed token is reused until the bucket changes.
 * @param config: (ApnsConfig) Configuration.
 * @param nowSeconds: (number) Current Unix time in seconds.
 * @return: (Promise<string>) The compact JWT.
 */
export async function getProviderToken(config: ApnsConfig, nowSeconds: number): Promise<string> {
  const issuedAt = Math.floor(nowSeconds / TOKEN_BUCKET_SECONDS) * TOKEN_BUCKET_SECONDS;
  const cacheKey = `${config.keyId}|${config.teamId}|${config.keyPem}|${issuedAt}`;
  if (cached && cached.cacheKey === cacheKey) return cached.token;
  const token = await signProviderToken(config, issuedAt);
  cached = { cacheKey, token };
  return token;
}

/**
 * purpose: Clear the cached provider token (tests).
 * @return: (void)
 */
export function resetProviderTokenCache(): void {
  cached = null;
}

/**
 * purpose: Map an APNs response to a per-token result.
 * @param token: (string) Device token.
 * @param status: (number) HTTP status.
 * @param reason: (string | null) APNs `reason` from the body, if any.
 * @return: (ApnsResult) Outcome: 200 sent; 410 unregistered (the only status whose token is
 *          deleted); 429 and 5xx failed retryable; other statuses, including 400 BadDeviceToken
 *          and DeviceTokenNotForTopic, failed not retryable.
 */
export function mapOutcome(token: string, status: number, reason: string | null): ApnsResult {
  if (status === 200) return { token, outcome: "sent", status, reason, retryable: false };
  if (status === 410) {
    return { token, outcome: "unregistered", status, reason, retryable: false };
  }
  const retryable = status === 429 || status >= 500;
  return { token, outcome: "failed", status, reason, retryable };
}

/**
 * purpose: A retryable failure with no HTTP response (timeout or connection error).
 * @param token: (string) Device token.
 * @param reason: (string) What went wrong.
 * @return: (ApnsResult) Failed, status 0, retryable.
 */
export function failureResult(token: string, reason: string): ApnsResult {
  return { token, outcome: "failed", status: 0, reason, retryable: true };
}
