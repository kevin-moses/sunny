export interface TimedResponse {
  ok: boolean;
  status: number;
  text: string;
  json: () => unknown;
}

export async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, json: () => JSON.parse(text) as unknown };
  } finally {
    clearTimeout(timer);
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isTimeoutError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}
