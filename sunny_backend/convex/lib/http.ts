// lib/http.ts
// Purpose: The one fetch wrapper with a timeout, shared by the Google and Twilio clients. The
// timeout covers the whole exchange including reading the response body, so a server that
// answers headers and then stalls cannot hang the caller. A timeout surfaces as an AbortError.
// Exports: TimedResponse, timedFetch, isTimeoutError.
//
// Last modified: 2026-10-29

/** A fully read response: status, body text, and JSON parsing of the text. */
export interface TimedResponse {
  ok: boolean;
  status: number;
  text: string;
  /** Parse the body as JSON; throws when it is not JSON. */
  json: () => unknown;
}

/**
 * purpose: fetch with a timeout that also covers reading the body.
 * @param url: (string) Request URL.
 * @param init: (RequestInit) fetch options.
 * @param timeoutMs: (number) Milliseconds before the request is aborted.
 * @return: (Promise<TimedResponse>) The response with its body read.
 * @raises AbortError when the timeout passes first.
 */
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

/**
 * purpose: Whether a caught value is the abort raised by timedFetch's timeout.
 * @param e: (unknown) Caught value.
 * @return: (boolean) True for an AbortError.
 */
export function isTimeoutError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}
