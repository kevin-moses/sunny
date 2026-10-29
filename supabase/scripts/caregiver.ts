// caregiver.ts
// Purpose: Command-line stand-in for the caregiver app until it exists. Talks to Supabase
// as a real caregiver (email and password sign-in, RLS applies) to exercise the calendar
// milestone end to end:
//   setup              Create a dev caregiver and household (service role, once), plus
//                      join codes for the senior phone and the home display. Saves the
//                      caregiver's credentials (git-ignored, one file per project).
//   chat "<message>"   Send a request to the household agent and wait for its reply.
//                      Add --continue to continue the previous conversation.
//   google             Print the Google consent link that connects this caregiver's
//                      Google Calendar.
//   day                Print the day view (what the display shows).
//   codes              Print fresh join codes for the senior phone and home display.
//   notices            Print this caregiver's queued notifications.
//
// Usage (local stack):
//   supabase status -o env > supabase/scripts/.env.local
//   deno run -A --env-file=supabase/scripts/.env.local supabase/scripts/caregiver.ts setup
// Usage (remote project):
//   supabase projects api-keys --project-ref <ref> --reveal -o env > supabase/scripts/.env.remote
//   echo 'SUPABASE_URL=https://<ref>.supabase.co' >> supabase/scripts/.env.remote
//   deno run -A --env-file=supabase/scripts/.env.remote supabase/scripts/caregiver.ts setup
// Reads the project URL, the publishable key and, for setup, the service-role key, under
// the names either command above writes.
//
// Last modified: 2026-10-28

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const API_URL_NAMES = ["API_URL", "SUPABASE_URL"];

interface DevState {
  email: string;
  password: string;
  household_id: string;
  last_job_id?: string;
}

/**
 * purpose: Read a required environment variable, accepting alternatives.
 * @param names: (string[]) Variable names in order of preference.
 * @return: (string) The first value set.
 */
function env(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value.replace(/^"|"$/g, "");
  }
  throw new Error(`Set one of: ${names.join(", ")}`);
}

let devFileCache: URL | undefined;

/**
 * purpose: The saved-caregiver file for the project the URL points at, resolved once.
 * @return: (URL) .dev.json for a local stack, .dev.<project-ref>.json for a hosted one.
 */
function devFile(): URL {
  if (!devFileCache) {
    const host = new URL(env(...API_URL_NAMES)).hostname;
    const local = host === "127.0.0.1" || host === "localhost";
    devFileCache = new URL(local ? "./.dev.json" : `./.dev.${host.split(".")[0]}.json`, import.meta.url);
  }
  return devFileCache;
}

/**
 * purpose: Load the saved dev caregiver.
 * @return: (DevState) Credentials and household.
 */
function loadState(): DevState {
  try {
    return JSON.parse(Deno.readTextFileSync(devFile()));
  } catch {
    throw new Error(`No ${devFile().pathname} yet; run \`setup\` first.`);
  }
}

/**
 * purpose: Save the dev caregiver (owner-only file permissions).
 * @param state: (DevState) Credentials and household.
 */
function saveState(state: DevState): void {
  Deno.writeTextFileSync(devFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * purpose: Sign in as the dev caregiver.
 * @param state: (DevState) Saved credentials.
 * @return: (Promise<SupabaseClient>) Client acting as the caregiver.
 */
async function signIn(state: DevState): Promise<SupabaseClient> {
  const key = env("ANON_KEY", "PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY");
  const client = createClient(env(...API_URL_NAMES), key, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: state.email, password: state.password });
  if (error) throw new Error(`Sign-in failed: ${error.message}`);
  return client;
}

/**
 * purpose: Create one join code.
 * @param client: (SupabaseClient) Caregiver client.
 * @param householdId: (string) Household id.
 * @param grants: (string) 'senior_phone' or 'home_display'.
 * @return: (Promise<string>) The code.
 */
async function joinCode(client: SupabaseClient, householdId: string, grants: string): Promise<string> {
  const { data, error } = await client.rpc("create_join_code", { p_household_id: householdId, p_grants: grants });
  if (error) throw new Error(error.message);
  return typeof data === "string" ? data : data.code;
}

/**
 * purpose: Print join codes for the senior phone and the home display.
 * @param client: (SupabaseClient) Caregiver client.
 * @param householdId: (string) Household id.
 */
async function printCodes(client: SupabaseClient, householdId: string): Promise<void> {
  console.log(`Senior phone join code: ${await joinCode(client, householdId, "senior_phone")}`);
  console.log(`Home display join code: ${await joinCode(client, householdId, "home_display")}`);
}

/**
 * purpose: Create the dev caregiver and household (once) and print join codes.
 */
async function setup(): Promise<void> {
  let existing: DevState | null = null;
  try {
    existing = loadState();
  } catch {
    // first run: no saved caregiver yet
  }
  if (existing) {
    console.log(`Already set up: household ${existing.household_id} (delete ${devFile().pathname} to start over)`);
    await printCodes(await signIn(existing), existing.household_id);
    return;
  }
  const adminKey = env("SERVICE_ROLE_KEY", "SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(env(...API_URL_NAMES), adminKey, {
    auth: { persistSession: false },
  });
  const email = `caregiver+${crypto.randomUUID().slice(0, 8)}@sunny.test`;
  const password = crypto.randomUUID();
  const { error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(userError.message);

  const client = await signIn({ email, password, household_id: "" });
  const { data: household, error } = await client.rpc("create_household", {
    p_senior_preferred_name: "Mom",
    p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    p_caregiver_display_name: "Kevin",
  });
  if (error) throw new Error(error.message);
  const householdId = typeof household === "string" ? household : household.id;
  saveState({ email, password, household_id: householdId });
  console.log(`Created household ${householdId} with a dev caregiver (saved to ${devFile().pathname})`);
  await printCodes(client, householdId);
}

/**
 * purpose: Send a message to the household agent and print its reply.
 * @param message: (string) The caregiver's request.
 * @param continueConversation: (boolean) Continue the previous agent conversation.
 */
async function chat(message: string, continueConversation: boolean): Promise<void> {
  const state = loadState();
  const client = await signIn(state);
  const { data: jobId, error } = await client.rpc("request_agent_chat", {
    p_household_id: state.household_id,
    p_message: message,
    p_continue_job_id: continueConversation ? state.last_job_id ?? null : null,
  });
  if (error) throw new Error(error.message);
  saveState({ ...state, last_job_id: jobId });
  console.log(`Queued job ${jobId}; waiting for the agent...`);

  const started = Date.now();
  while (Date.now() - started < 5 * 60_000) {
    const { data: job } = await client.from("jobs").select("status, result, last_error, attempts")
      .eq("id", jobId).single();
    if (job?.status === "succeeded") {
      console.log(`\nSunny: ${job.result?.reply}`);
      return;
    }
    if (job?.status === "failed") {
      console.log(`\nThe agent job failed: ${job.last_error}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("Still running after 5 minutes; check the jobs table.");
}

/**
 * purpose: Print the Google consent link for this caregiver.
 */
async function google(): Promise<void> {
  const state = loadState();
  const client = await signIn(state);
  const { data, error } = await client.functions.invoke("google-oauth/start", {
    body: { household_id: state.household_id },
  });
  if (error) throw new Error(`google-oauth/start failed: ${error.message}`);
  console.log(`Open this link to connect Google Calendar:\n${data.data.url}`);
}

/**
 * purpose: Print the day view.
 */
async function day(): Promise<void> {
  const state = loadState();
  const client = await signIn(state);
  const { data, error } = await client.rpc("get_day_view", { p_household_id: state.household_id });
  if (error) throw new Error(error.message);
  console.log(JSON.stringify(data, null, 2));
}

/**
 * purpose: Print this caregiver's queued notifications, newest first.
 */
async function notices(): Promise<void> {
  const state = loadState();
  const client = await signIn(state);
  const { data, error } = await client.from("notification_outbox")
    .select("created_at, kind, title, body, sent_at").order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  console.table(data);
}

const [command, ...rest] = Deno.args;
switch (command) {
  case "setup":
    await setup();
    break;
  case "chat": {
    const cont = rest.includes("--continue");
    const message = rest.filter((a) => a !== "--continue").join(" ");
    if (!message) throw new Error('Usage: chat "<message>" [--continue]');
    await chat(message, cont);
    break;
  }
  case "google":
    await google();
    break;
  case "day":
    await day();
    break;
  case "codes": {
    const state = loadState();
    await printCodes(await signIn(state), state.household_id);
    break;
  }
  case "notices":
    await notices();
    break;
  default:
    console.log("Commands: setup | chat \"<message>\" [--continue] | google | day | codes | notices");
}
