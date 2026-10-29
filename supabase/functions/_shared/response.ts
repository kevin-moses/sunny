// response.ts
// Purpose: Shared HTTP response helpers for Sunny Edge Functions: CORS headers, the
// { data, error } response envelope, and UUID validation.
// Memory-care pivot (2026-10-25): removed getUserId(), which trusted any UUID bearer token;
// callers are now identified by their verified Supabase JWT (see _shared/supabase.ts).
//
// Last modified: 2026-10-25

/** Matches a canonical UUID (versions 1-5). */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * purpose: Headers for every response, including CORS for browser clients.
 * @return: (HeadersInit) CORS and JSON content-type headers.
 */
export function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*", // TODO Phase 3: lock down origin
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json",
  };
}

/**
 * purpose: Wrap a payload in the { data, error: null } envelope.
 * @param data: (unknown) Response payload.
 * @param status: (number) HTTP status, default 200.
 * @return: (Response) JSON response.
 */
export function success(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: corsHeaders(),
  });
}

/**
 * purpose: Wrap an error in the { data: null, error: { message, code } } envelope.
 * @param message: (string) Human-readable error message.
 * @param code: (string) Stable machine-readable error code.
 * @param status: (number) HTTP status, default 400.
 * @return: (Response) JSON response.
 */
export function error(message: string, code: string, status = 400): Response {
  return new Response(
    JSON.stringify({ data: null, error: { message, code } }),
    {
      status,
      headers: corsHeaders(),
    },
  );
}
