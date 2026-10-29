// lib/apnsPayload.ts
// Purpose: Pure helpers for the Apple Push Notification sender (apns.ts), kept free of node:http2
// so they can be unit tested: configuration from the environment (APNS_KEY_ID, APNS_TEAM_ID,
// APNS_KEY_P8, APNS_BUNDLE_ID, APNS_ENVIRONMENT), host selection, the alert payload and request
// headers, the ES256 provider token (claims, PEM parsing, signing with WebCrypto, and a module
// scope cache refreshed after 50 minutes), and the mapping from an APNs response to a per-token
// outcome. Configuration problems raise ConfigError with the prefix "APNs is not configured".
// Exports: APNS_NOT_CONFIGURED, ApnsConfig, ApnsOutcome, ApnsResult, ApnsSendResult, loadApnsConfig, apnsHost,
// buildPayload, buildHeaders, jwtClaims, signProviderToken, getProviderToken,
// resetProviderTokenCache, mapOutcome, failureResult.
//
// Last modified: 2026-10-29

import { fromBase64, toBase64Url } from "./base64";
import { ConfigError } from "./errors";

/** Message prefix the caller can recognise as a configuration error. */
export const APNS_NOT_CONFIGURED = "APNs is not configured";

const SANDBOX_HOST = "api.sandbox.push.apple.com";
const PRODUCTION_HOST = "api.push.apple.com";
const DEFAULT_BUNDLE_ID = "com.kmsunny.sunny";
const EXPIRATION_SECONDS = 3 * 60 * 60;
const TOKEN_MAX_AGE_SECONDS = 50 * 60;

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
  const environment = (env.APNS_ENVIRONMENT?.trim() || "development").toLowerCase();
  if (environment !== "development" && environment !== "production") {
    throw new ConfigError(
      `${APNS_NOT_CONFIGURED}: APNS_ENVIRONMENT must be "development" or "production"`,
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
 * purpose: Build the JSON body of an alert push. Data keys stay as given (snake_case) and
 *          cannot override the aps dictionary.
 * @param title: (string) Alert title.
 * @param body: (string) Alert body.
 * @param data: (Record<string, string>) Optional custom keys.
 * @return: (string) Serialized payload.
 */
export function buildPayload(title: string, body: string, data?: Record<string, string>): string {
  return JSON.stringify({
    ...data,
    aps: { alert: { title, body }, sound: "default" },
  });
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
  if (taskId) headers["apns-collapse-id"] = taskId.slice(0, 64);
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

let cached: { cacheKey: string; token: string; issuedAt: number } | null = null;

/**
 * purpose: The provider token, reusing the cached one until it is 50 minutes old (APNs rejects
 *          tokens older than an hour and throttles refreshes more often than every 20 minutes).
 * @param config: (ApnsConfig) Configuration.
 * @param nowSeconds: (number) Current Unix time in seconds.
 * @return: (Promise<string>) The compact JWT.
 */
export async function getProviderToken(config: ApnsConfig, nowSeconds: number): Promise<string> {
  const cacheKey = `${config.keyId}|${config.teamId}|${config.keyPem}`;
  if (
    cached &&
    cached.cacheKey === cacheKey &&
    nowSeconds - cached.issuedAt < TOKEN_MAX_AGE_SECONDS
  ) {
    return cached.token;
  }
  const token = await signProviderToken(config, nowSeconds);
  cached = { cacheKey, token, issuedAt: nowSeconds };
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
 * @return: (ApnsResult) Outcome: 200 sent; 410 or 400 BadDeviceToken/DeviceTokenNotForTopic
 *          unregistered; 429 and 5xx failed retryable; other statuses failed not retryable.
 */
export function mapOutcome(token: string, status: number, reason: string | null): ApnsResult {
  if (status === 200) return { token, outcome: "sent", status, reason, retryable: false };
  const badToken =
    status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic");
  if (status === 410 || badToken) {
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
