// get-user-profile/index.ts
// Purpose: Returns the full user context (profile, facts, reminders, recent summaries)
// by calling the get_user_context Supabase RPC. Used by the iOS app on launch to
// pre-populate the agent's system prompt with personalized context.
//
// Last modified: 2026-02-24

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, error, getUserId, success } from "../_shared/response.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";

serve(async (req: Request) => {
  const started = Date.now();
  const userId = getUserId(req);
  const path = new URL(req.url).pathname;

  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (req.method !== "GET") {
      return error("Method not allowed", "METHOD_NOT_ALLOWED", 405);
    }

    const { data, error: rpcError } = await supabaseAdmin.rpc("get_user_context", {
      p_user_id: userId,
    });

    if (rpcError) {
      if (rpcError.message.toLowerCase().includes("not found")) {
        return error("User not found", "USER_NOT_FOUND", 404);
      }
      console.error("get_user_context RPC failed", rpcError);
      return error("Failed to load user profile", "PROFILE_FETCH_FAILED", 500);
    }

    const payload = {
      user: data?.profile ?? null,
      facts: data?.facts ?? {},
      reminders: data?.reminders ?? [],
      recent_summaries: data?.summaries ?? [],
    };

    return success(payload);
  } catch (err) {
    console.error("get-user-profile unhandled error", err);
    return error("Internal server error", "INTERNAL_ERROR", 500);
  } finally {
    console.log(
      JSON.stringify({
        method: req.method,
        path,
        user_id: userId,
        duration: Date.now() - started,
      }),
    );
  }
});
