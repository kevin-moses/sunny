// _shared/supabase.ts
// Purpose: Exports a shared Supabase admin client (service role) for use by all
// Sunny Edge Functions. Reads credentials from Deno environment variables and
// disables session persistence since Edge Functions are stateless.
//
// Last modified: 2026-02-24

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
