import { fromBase64, toBase64Url } from "./base64";
import { ConfigError } from "./errors";
import { HOUR_MS } from "./time";
import type { ActivityAttributes, ActivityCommand, ActivityStart } from "./liveActivity";
import type { ActivityContent, ApnsMessage, NotificationKind, PushType } from "./validators";

export const APNS_NOT_CONFIGURED = "APNs is not configured";

const SANDBOX_HOST = "api.sandbox.push.apple.com";
const PRODUCTION_HOST = "api.push.apple.com";
const DEFAULT_BUNDLE_ID = "com.kmsunny.sunny";
const ALERT_EXPIRATION_SECONDS = 3 * 60 * 60;
const ALERT_SOUND = "default";
const TOKEN_BUCKET_SECONDS = 30 * 60;

const APNS_COLLAPSE_ID_MAX_BYTES = 64;
const MAX_PAYLOAD_BYTES = 4096;

export const CAREGIVER_ALERT_CATEGORY = "caregiver_alert";

const ACTIVITY_ATTRIBUTES_TYPE = "SunnyTaskAttributes";

export const ACTIVITY_LIFETIME_MS = 12 * HOUR_MS;

const TOPIC_SUFFIX: Record<PushType, string> = {
  alert: "",
  background: "",
  liveactivity: ".push-type.liveactivity",
  widgets: ".push-type.widgets",
};

export type PushStyle = {
  interruptionLevel?: "time-sensitive";
  category?: string;
};

export type PushRecipient = { kind: "device" } | { kind: "caregiver"; canClaim: boolean };

const CAREGIVER_TIME_SENSITIVE: ReadonlySet<NotificationKind> = new Set([
  "caregiver_alert",
  "agent_flag",
]);

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

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function cutToFit(text: string, encode: (text: string) => string): string {
  let kept = text;
  let payload = encode(kept);
  while (utf8Length(payload) > MAX_PAYLOAD_BYTES && kept.length > 0) {
    kept = kept.slice(0, Math.floor(kept.length * 0.8));
    payload = encode(kept);
  }
  return payload;
}

export function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function alertMessage(
  title: string,
  body: string,
  data: Record<string, string> | undefined,
  style: PushStyle,
  nowSeconds: number,
): ApnsMessage {
  const extra: Record<string, string> = {};
  if (style.interruptionLevel !== undefined) extra["interruption-level"] = style.interruptionLevel;
  if (style.category !== undefined) extra["category"] = style.category;
  const message: ApnsMessage = {
    pushType: "alert",
    priority: 10,
    expiresAt: nowSeconds + ALERT_EXPIRATION_SECONDS,
    body: cutToFit(body, (text) =>
      JSON.stringify({
        ...data,
        aps: { alert: { title, body: text }, sound: ALERT_SOUND, ...extra },
      }),
    ),
  };
  const taskId = data?.task_instance_id;
  if (taskId) message.collapseId = taskId.slice(0, APNS_COLLAPSE_ID_MAX_BYTES);
  return message;
}

export function contentState(content: ActivityContent): ActivityContent {
  const { card, closed } = content;
  return {
    card: {
      instanceId: card.instanceId,
      step: card.step,
      stepCount: card.stepCount,
      stepText: card.stepText,
      label: card.label,
      sentence: card.sentence,
      detail: card.detail,
      icon: card.icon,
      startsAt: card.startsAt,
      endsAt: card.endsAt,
    },
    nextSteps: [...content.nextSteps],
    closed: closed === null ? null : { kind: closed.kind, at: closed.at },
  };
}

function startAlert(
  title: string,
  body: string,
  quiet: boolean,
): { title: string; body: string; sound?: string } {
  return quiet ? { title, body } : { title, body, sound: ALERT_SOUND };
}

export function liveActivityStartMessage(
  attributes: ActivityAttributes,
  start: ActivityStart,
  alert: { title: string; body: string },
  timestamp: number,
): ApnsMessage {
  const staleDate = seconds(start.staleAt);
  return {
    pushType: "liveactivity",
    priority: 10,
    expiresAt: staleDate,
    body: cutToFit(alert.body, (text) =>
      JSON.stringify({
        aps: {
          timestamp,
          event: "start",
          "attributes-type": ACTIVITY_ATTRIBUTES_TYPE,
          attributes: {
            activityKey: attributes.activityKey,
            instanceId: attributes.instanceId,
            receiptMs: attributes.receiptMs,
          },
          "content-state": contentState(start.content),
          alert: startAlert(alert.title, text, start.quiet),
          "stale-date": staleDate,
          "relevance-score": start.relevance,
        },
      }),
    ),
  };
}

export function liveActivityUpdateMessage(
  command: Extract<ActivityCommand, { kind: "update" }>,
  timestamp: number,
): ApnsMessage {
  const staleDate = seconds(command.staleAt);
  return {
    pushType: "liveactivity",
    priority: 10,
    expiresAt: staleDate,
    body: JSON.stringify({
      aps: {
        timestamp,
        event: "update",
        "content-state": contentState(command.content),
        "stale-date": staleDate,
      },
    }),
  };
}

export function liveActivityEndMessage(
  command: Extract<ActivityCommand, { kind: "end" }>,
  acceptedAt: number,
  timestamp: number,
): ApnsMessage {
  return {
    pushType: "liveactivity",
    priority: 10,
    expiresAt: seconds(acceptedAt + ACTIVITY_LIFETIME_MS),
    body: JSON.stringify({
      aps: {
        timestamp,
        event: "end",
        "content-state": contentState(command.content),
        "dismissal-date": seconds(command.receiptUntil ?? acceptedAt),
      },
    }),
  };
}

export function backgroundRefreshMessage(): ApnsMessage {
  return {
    pushType: "background",
    priority: 5,
    expiresAt: 0,
    body: JSON.stringify({ aps: { "content-available": 1 } }),
  };
}

export function widgetReloadMessage(): ApnsMessage {
  return {
    pushType: "widgets",
    priority: 10,
    expiresAt: 0,
    body: JSON.stringify({ aps: { "content-changed": true } }),
  };
}

export function buildHeaders(
  config: ApnsConfig,
  providerToken: string,
  message: ApnsMessage,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `bearer ${providerToken}`,
    "apns-topic": `${config.bundleId}${TOPIC_SUFFIX[message.pushType]}`,
    "apns-push-type": message.pushType,
    "apns-priority": String(message.priority),
    "apns-expiration": String(message.expiresAt),
    "content-type": "application/json",
  };
  if (message.collapseId !== undefined) headers["apns-collapse-id"] = message.collapseId;
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

export const INVALID_TOKEN_REASON = "InvalidToken";

const REASONS_ABOUT_THE_TOKEN: ReadonlySet<string> = new Set([
  INVALID_TOKEN_REASON,
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "MissingDeviceToken",
]);

const REASONS_ABOUT_THE_PAYLOAD: ReadonlySet<string> = new Set(["PayloadEmpty", "PayloadTooLarge"]);

const PROVIDER_STATUS = 403;

type ApnsAnswer =
  "sent" | "retry" | "token_refused" | "provider_refused" | "payload_refused" | "refused";

export function apnsAnswer(result: ApnsResult): ApnsAnswer {
  if (result.outcome === "sent") return "sent";
  if (result.outcome === "unregistered") return "token_refused";
  if (result.retryable) return "retry";
  if (result.status === PROVIDER_STATUS) return "provider_refused";
  if (result.reason !== null && REASONS_ABOUT_THE_TOKEN.has(result.reason)) return "token_refused";
  if (result.reason !== null && REASONS_ABOUT_THE_PAYLOAD.has(result.reason)) {
    return "payload_refused";
  }
  return "refused";
}

export function resultDetail(result: ApnsResult): string {
  return `${result.status} ${result.reason ?? "unknown"}`;
}

export function refusedTokens(results: ApnsResult[]): string[] {
  return results.filter((r) => apnsAnswer(r) === "token_refused").map((r) => r.token);
}

export function providerFault(results: ApnsResult[]): string | undefined {
  const refused = results.find((r) => apnsAnswer(r) === "provider_refused");
  return refused === undefined ? undefined : resultDetail(refused);
}

export function failureResult(token: string, reason: string): ApnsResult {
  return { token, outcome: "failed", status: 0, reason, retryable: true };
}
