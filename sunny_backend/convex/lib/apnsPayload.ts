import { fromBase64, toBase64Url } from "./base64";
import { ConfigError } from "./errors";
import type { NotificationKind } from "./validators";

export const APNS_NOT_CONFIGURED = "APNs is not configured";

const SANDBOX_HOST = "api.sandbox.push.apple.com";
const PRODUCTION_HOST = "api.push.apple.com";
const DEFAULT_BUNDLE_ID = "com.kmsunny.sunny";
const EXPIRATION_SECONDS = 3 * 60 * 60;
const TOKEN_BUCKET_SECONDS = 30 * 60;

const APNS_COLLAPSE_ID_MAX_BYTES = 64;
const MAX_PAYLOAD_BYTES = 4096;

export const CAREGIVER_ALERT_CATEGORY = "caregiver_alert";

export type PushStyle = {
  interruptionLevel?: "time-sensitive";
  category?: string;
};

export type PushRecipient = { kind: "device" } | { kind: "caregiver"; canClaim: boolean };

const TIME_SENSITIVE: Record<NotificationKind, Record<PushRecipient["kind"], boolean>> = {
  senior_prompt: { device: true, caregiver: false },
  caregiver_alert: { device: false, caregiver: true },
  event_notice: { device: false, caregiver: false },
  digest: { device: false, caregiver: false },
  agent_flag: { device: false, caregiver: true },
  family_message: { device: false, caregiver: false },
  senior_note: { device: false, caregiver: false },
  mail_escalation: { device: false, caregiver: true },
  mail_update: { device: false, caregiver: false },
};

export function pushStyle(kind: NotificationKind, recipient: PushRecipient): PushStyle {
  const style: PushStyle = {};
  if (TIME_SENSITIVE[kind][recipient.kind]) style.interruptionLevel = "time-sensitive";
  if (recipient.kind === "caregiver" && recipient.canClaim && kind === "caregiver_alert") {
    style.category = CAREGIVER_ALERT_CATEGORY;
  }
  return style;
}

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  keyPem: string;
  bundleId: string;
  environment: "development" | "production";
};

export type ApnsOutcome = "sent" | "unregistered" | "failed";

export type ApnsSendResult = { results: ApnsResult[]; configError?: string };

export type ApnsResult = {
  token: string;
  outcome: ApnsOutcome;
  status: number;
  reason: string | null;
  retryable: boolean;
};

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

export function apnsHost(environment: "development" | "production"): string {
  return environment === "production" ? PRODUCTION_HOST : SANDBOX_HOST;
}

export function isValidDeviceToken(token: string): boolean {
  return /^[0-9a-fA-F]{64,200}$/.test(token);
}

export function buildPayload(
  title: string,
  body: string,
  data?: Record<string, string>,
  style: PushStyle = {},
): string {
  const extra: Record<string, string> = {};
  if (style.interruptionLevel !== undefined) extra["interruption-level"] = style.interruptionLevel;
  if (style.category !== undefined) extra["category"] = style.category;
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
  if (taskId) headers["apns-collapse-id"] = taskId.slice(0, APNS_COLLAPSE_ID_MAX_BYTES);
  return headers;
}

export function jwtClaims(teamId: string, nowSeconds: number): { iss: string; iat: number } {
  return { iss: teamId, iat: nowSeconds };
}

function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (!match) throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_KEY_P8 is not a PEM private key`);
  try {
    return fromBase64((match[1] ?? "").replace(/\s+/g, ""));
  } catch {
    throw new ConfigError(`${APNS_NOT_CONFIGURED}: APNS_KEY_P8 is not valid base64`);
  }
}

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

export async function getProviderToken(config: ApnsConfig, nowSeconds: number): Promise<string> {
  const issuedAt = Math.floor(nowSeconds / TOKEN_BUCKET_SECONDS) * TOKEN_BUCKET_SECONDS;
  const cacheKey = `${config.keyId}|${config.teamId}|${config.keyPem}|${issuedAt}`;
  if (cached && cached.cacheKey === cacheKey) return cached.token;
  const token = await signProviderToken(config, issuedAt);
  cached = { cacheKey, token };
  return token;
}

export function resetProviderTokenCache(): void {
  cached = null;
}

export function mapOutcome(token: string, status: number, reason: string | null): ApnsResult {
  if (status === 200) return { token, outcome: "sent", status, reason, retryable: false };
  if (status === 410) {
    return { token, outcome: "unregistered", status, reason, retryable: false };
  }
  const retryable = status === 429 || status >= 500;
  return { token, outcome: "failed", status, reason, retryable };
}

export function failureResult(token: string, reason: string): ApnsResult {
  return { token, outcome: "failed", status: 0, reason, retryable: true };
}
