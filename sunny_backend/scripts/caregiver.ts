// scripts/caregiver.ts
// Purpose: Command-line stand-in for the caregiver app against a Convex dev deployment.
// Calls the backend's public functions through `npx convex run <fn> <json> --identity <json>`
// as a fixed dev caregiver (a made-up Clerk user id; the dev deployment trusts the CLI's
// admin identity, so no sign-in is needed). The household id and the last request id are
// kept in scripts/.dev-state.json (git-ignored). Not part of the deployed backend.
//
// Dev only: `--identity` impersonates any user, so the script refuses to run unless the
// deployment `npx convex run` would use is a dev deployment. The Convex CLI lets a shell-exported
// CONVEX_DEPLOY_KEY, CONVEX_DEPLOYMENT_TOKEN, CONVEX_DEPLOYMENT or CONVEX_SELF_HOSTED_URL win
// over sunny_backend/.env.local (and .env.local over .env), and a deploy key over
// CONVEX_DEPLOYMENT, so the guard (scripts/devGuard.ts) applies the same precedence to the
// environment, .env.local and .env, reading only those variables.
//
// Errors: a failed function call prints the server's message (the CLI's stderr is captured and
// the ConvexError message taken from it; scripts/profileLoader.ts cliError).
//
//   setup              Create a dev household (once) with the dev caregiver as primary, and
//                      print join codes for the senior phone and the home display. A caregiver
//                      belongs to at most one household, so if the dev caregiver already has
//                      one on the deployment (for example the state file was deleted), setup
//                      adopts it instead of creating another.
//   chat "<message>"   Send a request to the household agent (agentRequests:request), then
//                      poll agentRequests:get every 2 seconds and print the reply or error.
//                      Add --continue to continue the previous conversation.
//   day                Print the day view (calendar:dayView) as the displays see it.
//   codes              Print fresh join codes for the senior phone and the home display.
//   invite [primary|member|viewer]
//                      Create a caregiver invite code (households:createJoinCode, grants
//                      caregiver_<role>; default member) and print it. An unknown role exits 1.
//   google             Print the Google Calendar consent link (googleCalendar:connectUrl); open
//                      it signed in as a Google test user. See notes/GOOGLE_CALENDAR_SETUP.md.
//   phone <number>     Start verifying the dev caregiver's mobile number (households:setMyPhone):
//                      10-digit US or +E.164. Sunny texts a 6-digit code to it (needs the
//                      TWILIO_* variables on the deployment). Waits up to 30 seconds for
//                      the text to go out (households:myPhoneStatus) and prints either
//                      "Texted a code" or the send failure reason (exit code 1 unless the text went out).
//   confirm-phone <code>  Confirm that code (households:confirmMyPhone) and print the result.
//   profile-load <file.json> [--update]
//                      Load life profile entries, sensitive topics and caregiver facts from a
//                      JSON file through profile:addEntry, profile:addTopic and profile:addFact
//                      (format: scripts/profileLoader.ts; example: scripts/profile.example.json).
//                      Keep real data in scripts/profile.local.json (any scripts/*.local.json is
//                      git-ignored) so it is never committed. Safe to re-run: items already
//                      stored are not added again. Prints each item as added, unchanged,
//                      confirmed, differs (stored with other text, NOT updated), updated or
//                      failed; exit code 1 when any failed or differs. With --update, items stored
//                      with other text are replaced by the file's text (profile:updateEntry,
//                      profile:updateTopic; an entry with no details in the file loses its
//                      details). Slow: it starts one `npx convex run` process per item (and one
//                      more per update), roughly a second or two each.
//   profile            Print what is stored: life profile, sensitive topics, what Sunny
//                      remembers (verified or not) and the recent family messages.
//   message "<text>"   Send the senior a text message from the dev caregiver
//                      (profile:sendMessage).
//
// Usage (from sunny_backend/, with `npx convex dev` configured for the dev deployment):
//   npx tsx scripts/caregiver.ts setup
//   npx tsx scripts/caregiver.ts chat "Add lunch with Sarah on Friday at noon"
//   npx tsx scripts/caregiver.ts chat "Make it 12:30 instead" --continue
//   npx tsx scripts/caregiver.ts day
//   npx tsx scripts/caregiver.ts invite viewer
//   npx tsx scripts/caregiver.ts google
//   npx tsx scripts/caregiver.ts phone 555-123-4567
//   npx tsx scripts/caregiver.ts confirm-phone 123456
//   npx tsx scripts/caregiver.ts profile-load scripts/profile.local.json
//   npx tsx scripts/caregiver.ts profile-load scripts/profile.local.json --update
//   npx tsx scripts/caregiver.ts profile
//   npx tsx scripts/caregiver.ts message "Coming by at noon. Love, J"
//
// Last modified: 2026-11-09

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntryView, MemoryView, MessageView, TopicView } from "../convex/profile";
import { deploymentProblem, parseEnvFile } from "./devGuard";
import { cliError, loadProfile, parseProfileFile } from "./profileLoader";
import type { LoadReport } from "./profileLoader";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(SCRIPT_DIR, "..");
const STATE_FILE = join(SCRIPT_DIR, ".dev-state.json");
const POLL_MS = 2_000;
const GIVE_UP_MS = 35 * 60_000;

/** The fixed dev caregiver, as the Clerk-style identity `convex run --identity` accepts. */
const DEV_IDENTITY = {
  subject: "user_sunny_dev_caregiver",
  issuer: "https://sunny.dev.local",
  name: "Dev Caregiver",
};

/**
 * purpose: The variables of a dotenv file in sunny_backend, or none when it does not exist.
 * @param name: (string) File name, ".env.local" or ".env".
 * @return: (Record<string, string | undefined>) Its variables.
 */
function envFile(name: string): Record<string, string | undefined> {
  const path = join(BACKEND_DIR, name);
  return existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
}

/**
 * purpose: Refuse to run unless `npx convex run` would act on a dev deployment, using the CLI's
 *          precedence (shell environment, then .env.local, then .env; a deploy key first). Never
 *          prints variable values.
 * @return: (void)
 * @raises Error naming the problem when the target is not a dev deployment.
 */
function requireDevDeployment(): void {
  const problem = deploymentProblem([process.env, envFile(".env.local"), envFile(".env")]);
  if (problem !== null) {
    throw new Error(
      `This script impersonates a user, so it only runs against a dev deployment: ${problem}. ` +
        "Unset deploy keys in the shell and set CONVEX_DEPLOYMENT=dev:... in " +
        "sunny_backend/.env.local (run `npx convex dev` once).",
    );
  }
}

/** What the script remembers between runs. */
interface DevState {
  householdId: string;
  lastRequestId?: string;
}

/** The part of an agent request the script prints. */
interface RequestView {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  reply: string | null;
  error: string | null;
}

/** What to print for each finished status; queued and running keep waiting. */
const FINISHED_MESSAGES: Record<string, (view: RequestView) => string> = {
  succeeded: (view) => `\nSunny: ${view.reply}`,
  failed: (view) => `\nThe agent request failed: ${view.error}`,
  cancelled: () => "\nThe request was cancelled.",
};

/**
 * purpose: Call a backend function as the dev caregiver. The CLI's stderr is captured so a
 *          failure carries the server's message instead of "Command failed: npx convex run ...".
 * @param fn: (string) Function path such as "agentRequests:request".
 * @param args: (Record<string, unknown>) Function arguments.
 * @return: (unknown) The parsed JSON result.
 * @raises Error with the server's message when the call fails.
 */
function convexRun(fn: string, args: Record<string, unknown>): unknown {
  let out: string;
  try {
    out = execFileSync(
      "npx",
      ["convex", "run", fn, JSON.stringify(args), "--identity", JSON.stringify(DEV_IDENTITY)],
      { cwd: BACKEND_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    throw cliError(stderr, `npx convex run ${fn} failed`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`Unexpected output from ${fn}: ${out}`);
  }
}

/**
 * purpose: Load the saved dev state.
 * @return: (DevState) The household and last request.
 */
function loadState(): DevState {
  if (!existsSync(STATE_FILE)) throw new Error("No dev household yet; run `setup` first.");
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DevState;
}

/**
 * purpose: Save the dev state (owner-only file permissions).
 * @param state: (DevState) State to save.
 */
function saveState(state: DevState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * purpose: Print fresh join codes for the senior phone and the home display.
 * @param householdId: (string) Household id.
 */
function printCodes(householdId: string): void {
  for (const [label, grants] of [
    ["Senior phone", "senior_phone"],
    ["Home display", "home_display"],
  ] as const) {
    const result = convexRun("households:createJoinCode", { householdId, grants }) as {
      code: string;
    };
    console.log(`${label} join code: ${result.code}`);
  }
}

/** Caregiver roles an invite code can grant. */
const INVITE_ROLES = ["primary", "member", "viewer"] as const;

/**
 * purpose: Create and print a caregiver invite code for the dev household.
 * @param role: (string) One of primary, member or viewer.
 */
function invite(role: string): void {
  if (!(INVITE_ROLES as readonly string[]).includes(role)) {
    console.error(`Unknown role "${role}"; use one of: ${INVITE_ROLES.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const result = convexRun("households:createJoinCode", {
    householdId: loadState().householdId,
    grants: `caregiver_${role}`,
  }) as { code: string };
  console.log(`Caregiver invite code (${role}): ${result.code}`);
}

/**
 * purpose: The id of the household the dev caregiver already belongs to on the deployment.
 *          A caregiver belongs to at most one household, so there is at most one.
 * @return: (string | null) The household id, or null when the dev caregiver has none.
 */
function findExistingHousehold(): string | null {
  const mine = convexRun("households:mine", {}) as {
    households: Array<{ household: { _id: string } }>;
  };
  return mine.households[0]?.household._id ?? null;
}

/**
 * purpose: Create the dev household once (or adopt the dev caregiver's existing one when the
 *          state file is missing) and print join codes.
 */
function setup(): void {
  if (existsSync(STATE_FILE)) {
    const state = loadState();
    console.log(
      `Already set up: household ${state.householdId} (delete ${STATE_FILE} to start over)`,
    );
    printCodes(state.householdId);
    return;
  }
  const existing = findExistingHousehold();
  if (existing !== null) {
    saveState({ householdId: existing });
    console.log(`Adopted existing household ${existing} (saved to ${STATE_FILE})`);
    printCodes(existing);
    return;
  }
  const householdId = convexRun("households:create", {
    seniorPreferredName: "Mom",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    caregiverDisplayName: "Dev Caregiver",
  }) as string;
  saveState({ householdId });
  console.log(`Created household ${householdId} (saved to ${STATE_FILE})`);
  printCodes(householdId);
}

/**
 * purpose: Send a message to the household agent and print its reply.
 * @param message: (string) The caregiver's request.
 * @param continueConversation: (boolean) Continue the previous conversation.
 * @return: (Promise<void>) Resolves when the request finishes or the wait gives up.
 */
async function chat(message: string, continueConversation: boolean): Promise<void> {
  const state = loadState();
  if (continueConversation && !state.lastRequestId) {
    throw new Error("Nothing to continue; send a request first.");
  }
  const requestId = convexRun("agentRequests:request", {
    householdId: state.householdId,
    message,
    ...(continueConversation ? { continueRequestId: state.lastRequestId } : {}),
  }) as string;
  saveState({ ...state, lastRequestId: requestId });
  console.log(`Queued request ${requestId}; waiting for the agent...`);

  const started = Date.now();
  while (Date.now() - started < GIVE_UP_MS) {
    const view = convexRun("agentRequests:get", { requestId }) as RequestView;
    const render = FINISHED_MESSAGES[view.status];
    if (render) {
      console.log(render(view));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.log(
    `Still running after ${GIVE_UP_MS / 60_000} minutes; check agentRequests in the dashboard.`,
  );
}

/**
 * purpose: Print the day view.
 */
function day(): void {
  const state = loadState();
  console.log(
    JSON.stringify(convexRun("calendar:dayView", { householdId: state.householdId }), null, 2),
  );
}

/**
 * purpose: Print the Google Calendar consent link for the dev caregiver.
 */
function google(): void {
  const state = loadState();
  const url = convexRun("googleCalendar:connectUrl", { householdId: state.householdId });
  console.log(`Open this link signed in as a Google test user:
${url}`);
}

/** How long `phone` waits for the code text to go out, and how often it checks. */
const PHONE_WAIT_MS = 30_000;
const PHONE_POLL_MS = 1_000;

/** Shape of households:myPhoneStatus; phone and expiresAt exist only when sent. */
type PhoneStatus =
  | { status: "none" | "expired" | "sending" }
  | { status: "sent"; phone: string; expiresAt: number }
  | { status: "send_failed"; error: string };

/**
 * purpose: Start verifying the dev caregiver's phone number; Sunny texts the code. Waits
 *          briefly for the send to finish so a failure is reported instead of hidden.
 * @param number: (string) Number as typed.
 * @return: (Promise<void>) Resolves when the outcome is printed.
 */
async function startPhone(number: string): Promise<void> {
  const state = loadState();
  convexRun("households:setMyPhone", { householdId: state.householdId, phone: number });
  const deadline = Date.now() + PHONE_WAIT_MS;
  let status: PhoneStatus = { status: "sending" };
  while (status.status === "sending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PHONE_POLL_MS));
    status = convexRun("households:myPhoneStatus", {
      householdId: state.householdId,
    }) as PhoneStatus;
  }
  if (status.status === "sent") {
    console.log(
      `Texted a code to ${status.phone}; it expires at ${new Date(status.expiresAt).toLocaleTimeString()}. ` +
        "Run `confirm-phone <code>` next.",
    );
  } else if (status.status === "send_failed") {
    console.log(`The code text could not be sent: ${status.error}`);
    process.exitCode = 1;
  } else if (status.status === "sending") {
    console.log(
      "The code text is still being sent; check your phone, then run `confirm-phone <code>`.",
    );
    process.exitCode = 1;
  } else {
    console.log(`No code is pending (${status.status}); run \`phone <number>\` again.`);
    process.exitCode = 1;
  }
}

/** Messages for each confirmMyPhone status. */
const CONFIRM_MESSAGES: Record<string, (r: { phone?: string; attemptsLeft?: number }) => string> = {
  verified: (r) => `Verified ${r.phone}. Sunny can now text you.`,
  wrong_code: (r) => `Wrong code; ${r.attemptsLeft} attempts left.`,
  expired: () => "That code expired; run `phone <number>` for a new one.",
  locked: () => "Too many wrong codes; run `phone <number>` for a new one.",
  none: () => "No verification is pending; run `phone <number>` first.",
};

/**
 * purpose: Confirm the texted code for the dev caregiver's phone number.
 * @param code: (string) The 6-digit code.
 */
function confirmPhone(code: string): void {
  const state = loadState();
  const result = convexRun("households:confirmMyPhone", {
    householdId: state.householdId,
    code,
  }) as { status: string; phone?: string; attemptsLeft?: number };
  console.log((CONFIRM_MESSAGES[result.status] ?? (() => JSON.stringify(result)))(result));
}

/** How each loader outcome is printed: a column label and an optional note. */
const OUTCOME_LINES: Array<[keyof Omit<LoadReport, "failed">, string, string]> = [
  ["added", "Added    ", ""],
  ["unchanged", "Unchanged", " (already stored)"],
  ["confirmed", "Confirmed", " (Sunny had heard this; now confirmed)"],
  ["updated", "Updated  ", " (replaced by the file's text)"],
  ["differs", "Differs  ", " (stored with other text, NOT updated; rerun with --update)"],
];

/**
 * purpose: Load a profile file into the dev household and print what happened to each item.
 *          Slow: one `npx convex run` process per item.
 * @param path: (string) Path of the JSON file.
 * @param update: (boolean) Replace items stored with other text by the file's text.
 * @return: (Promise<void>) Resolves when every item was tried; sets exit code 1 when any item
 *          failed or differs.
 */
async function profileLoad(path: string, update: boolean): Promise<void> {
  const file = parseProfileFile(JSON.parse(readFileSync(path, "utf8")));
  const report = await loadProfile(file, loadState().householdId, convexRun, { update });
  for (const [key, label, note] of OUTCOME_LINES) {
    for (const item of report[key]) console.log(`${label} ${item}${note}`);
  }
  for (const { item, error } of report.failed) console.log(`Failed    ${item}: ${error}`);
  const counts = OUTCOME_LINES.map(([key]) => `${report[key].length} ${key}`);
  console.log(`\n${[...counts, `${report.failed.length} failed`].join(", ")}.`);
  if (report.failed.length > 0 || report.differs.length > 0) process.exitCode = 1;
}

/**
 * purpose: Print everything the profile functions store for the dev household.
 * @return: (void)
 */
function printProfile(): void {
  const householdId = loadState().householdId;
  const entries = convexRun("profile:listEntries", { householdId }) as EntryView[];
  const topics = convexRun("profile:listTopics", { householdId }) as TopicView[];
  const memory = convexRun("profile:listMemory", { householdId }) as MemoryView;
  const messages = convexRun("profile:listMessages", { householdId }) as MessageView[];

  console.log(`Life profile (${entries.length}):`);
  for (const e of entries) {
    console.log(`  ${e.category} - ${e.name}${e.details === null ? "" : `: ${e.details}`}`);
  }
  console.log(`\nSensitive topics (${topics.length}):`);
  for (const t of topics) console.log(`  If asked about ${t.topic}: ${t.guidance}`);
  console.log(`\nWhat Sunny remembers (${memory.facts.length}):`);
  for (const f of memory.facts) {
    const state = f.verified
      ? `verified${f.verifiedByName === null ? "" : ` by ${f.verifiedByName}`}`
      : "NOT VERIFIED";
    console.log(`  ${f.fact} (${f.source}, ${f.notedOn}, ${state})`);
  }
  if (memory.olderUnverified > 0) {
    console.log(`  ...and ${memory.olderUnverified} older unverified facts not listed`);
  }
  console.log(`\nRecent messages (${messages.length}, newest first):`);
  for (const m of messages) {
    const seen = m.senderKind === "caregiver" ? (m.seenAt === null ? ", not seen" : ", seen") : "";
    console.log(
      `  ${m.sentDate} ${m.sentTime} ${m.senderName}${seen}: ${m.body ?? "(photo or audio)"}`,
    );
  }
}

/**
 * purpose: Send the senior a text message as the dev caregiver.
 * @param body: (string) The message.
 * @return: (void)
 */
function message(body: string): void {
  convexRun("profile:sendMessage", { householdId: loadState().householdId, body });
  console.log("Sent.");
}

/**
 * purpose: Dispatch the command line.
 * @param argv: (string[]) Arguments after the script name.
 * @return: (Promise<void>) Resolves when the command finishes.
 */
async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== undefined) requireDevDeployment();
  switch (command) {
    case "setup":
      setup();
      break;
    case "chat": {
      const message = rest.filter((a) => a !== "--continue").join(" ");
      if (!message) throw new Error('Usage: chat "<message>" [--continue]');
      await chat(message, rest.includes("--continue"));
      break;
    }
    case "day":
      day();
      break;
    case "codes":
      printCodes(loadState().householdId);
      break;
    case "invite":
      invite(rest[0] ?? "member");
      break;
    case "google":
      google();
      break;
    case "phone":
      if (!rest[0]) throw new Error("Usage: phone <number>");
      await startPhone(rest.join(" "));
      break;
    case "confirm-phone":
      if (!rest[0]) throw new Error("Usage: confirm-phone <code>");
      confirmPhone(rest[0]);
      break;
    case "profile-load": {
      const path = rest.find((a) => a !== "--update");
      if (!path) throw new Error("Usage: profile-load <file.json> [--update]");
      await profileLoad(path, rest.includes("--update"));
      break;
    }
    case "profile":
      printProfile();
      break;
    case "message":
      if (!rest.join(" ").trim()) throw new Error('Usage: message "<text>"');
      message(rest.join(" "));
      break;
    default:
      console.log(
        'Commands: setup | chat "<message>" [--continue] | day | codes | invite [primary|member|viewer] | google | phone <number> | confirm-phone <code> | profile-load <file.json> [--update] (slow: one convex process per item; keep real data in scripts/profile.local.json) | profile | message "<text>"',
      );
  }
}

await main(process.argv.slice(2));
