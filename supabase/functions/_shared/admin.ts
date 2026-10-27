// _shared/admin.ts
// Purpose: Service-role Supabase client for backend work that has no end user behind it:
// the job runner (jobs-run) and the Google OAuth callback. It bypasses row level
// security, so only code that has already authorized the request (a verified jobs
// secret, a signed OAuth state) may use it. Every household-scoped call must pass the
// household taken from a trusted row, never from model or client input.
//
// Also holds the shared RPC call helper and a constant-time comparison for secrets.
//
// Last modified: 2026-10-27

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** A database RPC returned an error (its message is safe to log or show the agent). */
export class RpcError extends Error {}

/**
 * purpose: Call a Postgres RPC and return its data.
 * @param client: (SupabaseClient) Any Supabase client.
 * @param fn: (string) RPC name.
 * @param args: (Record<string, unknown>) Named arguments.
 * @return: (Promise<T>) The RPC result.
 * @raises RpcError with the database's message when the call fails.
 */
export async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new RpcError(error.message);
  return data as T;
}

/**
 * purpose: Create a Supabase client with the service role key (backend privileges).
 * @return: (SupabaseClient) Client that bypasses RLS; RPCs see it as the backend.
 */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * purpose: Constant-time string comparison for shared secrets.
 * @param a: (string) First value.
 * @param b: (string) Second value.
 * @return: (boolean) True when both are equal.
 */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
