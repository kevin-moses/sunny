// _shared/supabase.ts
// Purpose: Builds a Supabase client that acts as the calling user, so every query an Edge
// Function makes on their behalf goes through the same row level security as the apps.
// Reads SUPABASE_URL and SUPABASE_ANON_KEY (provided automatically to Edge Functions) and
// forwards the request's Authorization header.
//
// Memory-care pivot (2026-10-25): replaced the shared service-role admin client with a
// per-request user client; functions should not bypass RLS unless they have to.
//
// Last modified: 2026-10-25

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * purpose: Create a Supabase client scoped to the caller of this request.
 * @param req: (Request) Incoming request; its Authorization header carries the user's JWT.
 * @return: (SupabaseClient) Client whose queries run as the caller under RLS.
 */
export function userClient(req: Request): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("Missing required env vars: SUPABASE_URL and SUPABASE_ANON_KEY");
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
