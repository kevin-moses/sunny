// lib/http.ts
// Purpose: The one fetch wrapper with a timeout, shared by the Google and Twilio clients. A
// request that outlives its timeout is aborted, which fetch reports as an AbortError.
// Exports: timedFetch, isTimeoutError.
//
// Last modified: 2026-10-29

/**
 * purpose: fetch with a timeout.
 * @param url: (string) Request URL.
 * @param init: (RequestInit) fetch options.
 * @param timeoutMs: (number) Milliseconds before the request is aborted.
 * @return: (Promise<Response>) The response.
 * @raises AbortError when the timeout passes first.
 */
export async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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
