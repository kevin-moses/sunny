// google-oauth/index.ts
// Purpose: Connects a caregiver's Google account so Sunny can keep a calendar there.
//   POST /google-oauth/start    { household_id } with the caregiver's Supabase JWT.
//        Returns { url }: Google's consent page (calendar.app.created scope only) with a
//        signed, 15-minute state naming the caregiver and household.
//   GET  /google-oauth/callback ?code&state  (Google redirects the browser here; public).
//        Verifies the state, exchanges the code, creates "<Senior> (Sunny)" in the
//        caregiver's Google account (or reuses the one from an earlier connection), and
//        saves the connection through save_calendar_connection, which stores the refresh
//        token in Vault and queues a push of every event. Answers with a small HTML page.
// verify_jwt is off for this function (the callback carries no JWT); /start checks the
// JWT itself. Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
// GOOGLE_OAUTH_STATE_SECRET.
//
// Last modified: 2026-10-27

import { serviceClient } from "../_shared/admin.ts";
import {
  CALENDAR_SCOPE,
  calendarExists,
  consentUrl,
  createSunnyCalendar,
  exchangeCode,
  signState,
  verifyState,
} from "../_shared/google.ts";
import { corsHeaders, error, success, UUID_REGEX } from "../_shared/response.ts";
import { userClient } from "../_shared/supabase.ts";

/**
 * purpose: A minimal HTML page for the end of the browser flow.
 * @param title: (string) Heading.
 * @param message: (string) One sentence for the caregiver.
 * @param status: (number) HTTP status.
 * @return: (Response) HTML response.
 */
function page(title: string, message: string, status = 200): Response {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escape(title)}</title></head><body style="font-family:-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * purpose: Start the flow for a signed-in caregiver of the household.
 * @param req: (Request) POST with { household_id } and the caregiver's JWT.
 * @return: (Promise<Response>) { url } to open in the browser.
 */
async function start(req: Request): Promise<Response> {
  let householdId: unknown;
  try {
    householdId = (await req.json()).household_id;
  } catch {
    return error("Request body must be valid JSON", "INVALID_BODY", 400);
  }
  if (typeof householdId !== "string" || !UUID_REGEX.test(householdId)) {
    return error("household_id must be a UUID", "INVALID_HOUSEHOLD", 400);
  }
  const supabase = userClient(req);
  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user;
  if (!user || user.is_anonymous) {
    return error("Caregiver sign-in required", "UNAUTHORIZED", 401);
  }
  // RLS returns the membership row only for the caregiver's own households.
  const { data: member } = await supabase.from("household_members").select("user_id")
    .eq("household_id", householdId).eq("user_id", user.id).maybeSingle();
  if (!member) {
    return error("Not a caregiver in this household", "FORBIDDEN", 403);
  }
  return success({ url: consentUrl(await signState(user.id, householdId)) });
}

/**
 * purpose: Finish the flow after Google redirects back.
 * @param url: (URL) Callback URL with code and state (or error).
 * @return: (Promise<Response>) HTML page saying whether it worked.
 */
async function callback(url: URL): Promise<Response> {
  if (url.searchParams.get("error")) {
    return page("Not connected", "Google Calendar was not connected. You can try again from the Sunny app.", 400);
  }
  const state = await verifyState(url.searchParams.get("state") ?? "");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    return page("Link expired", "This link has expired. Start again from the Sunny app.", 400);
  }

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.scopes.includes(CALENDAR_SCOPE)) {
      return page(
        "Permission needed",
        "Sunny needs permission to manage the calendar it creates. Start again and allow it.",
        400,
      );
    }
    const db = serviceClient();
    const { data: household, error: householdError } = await db.from("households")
      .select("senior_preferred_name, timezone").eq("id", state.householdId).single();
    if (householdError || !household) throw new Error("Household not found");

    const { data: existing } = await db.from("calendar_connections").select("external_calendar_id")
      .eq("household_id", state.householdId).eq("user_id", state.userId).eq("provider", "google")
      .maybeSingle();
    const calendarId = existing && await calendarExists(tokens.accessToken, existing.external_calendar_id)
      ? existing.external_calendar_id
      : await createSunnyCalendar(tokens.accessToken, household.senior_preferred_name, household.timezone);

    const { error: saveError } = await db.rpc("save_calendar_connection", {
      p_household_id: state.householdId,
      p_user_id: state.userId,
      p_account_email: tokens.email,
      p_external_calendar_id: calendarId,
      p_refresh_token: tokens.refreshToken,
    });
    if (saveError) throw new Error(saveError.message);
    return page(
      "Google Calendar connected",
      `"${household.senior_preferred_name} (Sunny)" is now in your Google Calendar and stays up to date. You can close this page.`,
    );
  } catch (e) {
    console.error(`google-oauth callback failed: ${e instanceof Error ? e.message : e}`);
    return page("Something went wrong", "Google Calendar could not be connected. Please try again.", 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname.endsWith("/start")) return await start(req);
  if (req.method === "GET" && url.pathname.endsWith("/callback")) return await callback(url);
  return error("Not found", "NOT_FOUND", 404);
});
