import { GoogleApiError } from "./google";
import { timedFetch } from "./http";
import type { TimedResponse } from "./http";
import { DAY_MS } from "./time";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const REQUEST_TIMEOUT_MS = 15_000;
const HISTORY_PAGE_SIZE = 100;
const LIST_PAGE_SIZE = 100;
const SAFE_ADDRESS = /^[^\s"'()<>\\]+$/;

export type HistoryPage = { ids: string[]; lastHistoryId: string | null; next: string | null };

async function gmailGet(
  accessToken: string,
  path: string,
  params: Array<[string, string]>,
): Promise<TimedResponse> {
  const query = new URLSearchParams(params);
  return await timedFetch(
    `${GMAIL_API}${path}?${query}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    REQUEST_TIMEOUT_MS,
  );
}

async function gmailJson(
  accessToken: string,
  path: string,
  params: Array<[string, string]>,
): Promise<Record<string, unknown>> {
  const res = await gmailGet(accessToken, path, params);
  if (!res.ok) throw new GoogleApiError(res.status, res.text);
  const body: unknown = res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GoogleApiError(502, "Gmail answered with something other than an object");
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value === "") {
    throw new GoogleApiError(502, `Gmail answer is missing ${name}`);
  }
  return value;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

export async function getProfile(
  accessToken: string,
): Promise<{ email: string; historyId: string }> {
  const body = await gmailJson(accessToken, "/profile", []);
  return { email: stringField(body, "emailAddress"), historyId: stringField(body, "historyId") };
}

export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<HistoryPage | "expired"> {
  const params: Array<[string, string]> = [
    ["startHistoryId", startHistoryId],
    ["historyTypes", "messageAdded"],
    ["labelId", "INBOX"],
    ["maxResults", String(HISTORY_PAGE_SIZE)],
  ];
  if (pageToken !== undefined) params.push(["pageToken", pageToken]);
  const res = await gmailGet(accessToken, "/history", params);
  if (res.status === 404) return "expired";
  if (!res.ok) throw new GoogleApiError(res.status, res.text);
  const body = res.json() as Record<string, unknown>;
  const history = records(body.history);
  const ids = new Set<string>();
  for (const record of history) {
    for (const added of records(record.messagesAdded)) {
      const id = (added.message as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  const next = typeof body.nextPageToken === "string" ? body.nextPageToken : null;
  const lastRecordId = history.at(-1)?.id;
  if (next === null) return { ids: [...ids], lastHistoryId: stringField(body, "historyId"), next };
  return {
    ids: [...ids],
    lastHistoryId: typeof lastRecordId === "string" ? lastRecordId : null,
    next,
  };
}

export async function listRecent(
  accessToken: string,
  sinceMs: number,
  max: number,
): Promise<string[]> {
  const days = Math.max(1, Math.ceil((Date.now() - sinceMs) / DAY_MS));
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Array<[string, string]> = [
      ["labelIds", "INBOX"],
      ["q", `newer_than:${days}d`],
      ["maxResults", String(Math.min(LIST_PAGE_SIZE, max - ids.length))],
    ];
    if (pageToken !== undefined) params.push(["pageToken", pageToken]);
    const body = await gmailJson(accessToken, "/messages", params);
    for (const message of records(body.messages)) {
      if (typeof message.id === "string") ids.push(message.id);
    }
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
  } while (pageToken !== undefined && ids.length < max);
  return ids.slice(0, max);
}

export async function getMessage(accessToken: string, id: string): Promise<unknown | null> {
  const res = await gmailGet(accessToken, `/messages/${encodeURIComponent(id)}`, [
    ["format", "full"],
  ]);
  if (res.status === 404) return null;
  if (!res.ok) throw new GoogleApiError(res.status, res.text);
  return res.json();
}

export async function hasSentTo(accessToken: string, address: string): Promise<boolean> {
  if (!SAFE_ADDRESS.test(address)) return false;
  const body = await gmailJson(accessToken, "/messages", [
    ["labelIds", "SENT"],
    ["q", `to:${address}`],
    ["maxResults", "1"],
  ]);
  return records(body.messages).length > 0;
}
