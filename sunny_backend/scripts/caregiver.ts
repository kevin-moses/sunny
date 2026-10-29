// scripts/caregiver.ts
// Purpose: Command-line stand-in for the caregiver app against a Convex dev deployment.
// Calls the backend's public functions through `npx convex run <fn> <json> --identity <json>`
// as a fixed dev caregiver (a made-up Clerk user id; the dev deployment trusts the CLI's
// admin identity, so no sign-in is needed). The household id and the last request id are
// kept in scripts/.dev-state.json (git-ignored). Not part of the deployed backend.
//
// Dev only: `--identity` impersonates any user, so the script refuses to run unless
// CONVEX_DEPLOYMENT in sunny_backend/.env.local starts with "dev:" (only that one line is read).
//
//   setup              Create a dev household (once) with the dev caregiver as primary, and
//                      print join codes for the senior phone and the home display.
//   chat "<message>"   Send a request to the household agent (agentRequests:request), then
//                      poll agentRequests:get every 2 seconds and print the reply or error.
//                      Add --continue to continue the previous conversation.
//   day                Print the day view (calendar:dayView) as the displays see it.
//   codes              Print fresh join codes for the senior phone and the home display.
//   google             Print the Google Calendar consent link (googleCalendar:connectUrl); open
//                      it signed in as a Google test user. See notes/GOOGLE_CALENDAR_SETUP.md.
//   phone <number>     Start verifying the dev caregiver's mobile number (households:setMyPhone):
//                      10-digit US or +E.164. Sunny texts a 6-digit code to it (needs the
//                      TWILIO_* variables on the deployment).
//   confirm-phone <code>  Confirm that code (households:confirmMyPhone) and print the result.
//
// Usage (from sunny_backend/, with `npx convex dev` configured for the dev deployment):
//   npx tsx scripts/caregiver.ts setup
//   npx tsx scripts/caregiver.ts chat "Add lunch with Sarah on Friday at noon"
//   npx tsx scripts/caregiver.ts chat "Make it 12:30 instead" --continue
//   npx tsx scripts/caregiver.ts day
//   npx tsx scripts/caregiver.ts google
//   npx tsx scripts/caregiver.ts phone 555-123-4567
//   npx tsx scripts/caregiver.ts confirm-phone 123456
//
// Last modified: 2026-10-29

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * purpose: Refuse to run against anything but a dev deployment. Reads only the
 *          CONVEX_DEPLOYMENT line of sunny_backend/.env.local and never prints other contents.
 * @raises Error when the file or line is missing or the deployment does not start with "dev:".
 */
function requireDevDeployment(): void {
  const envFile = join(BACKEND_DIR, ".env.local");
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const match = /^CONVEX_DEPLOYMENT=["']?([^\s"'#]*)/m.exec(text);
  if (!match || !match[1]!.startsWith("dev:")) {
    throw new Error(
      "This script impersonates a user, so it only runs against a dev deployment: set " +
        "CONVEX_DEPLOYMENT=dev:... in sunny_backend/.env.local (run `npx convex dev` once).",
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
 * purpose: Call a backend function as the dev caregiver.
 * @param fn: (string) Function path such as "agentRequests:request".
 * @param args: (Record<string, unknown>) Function arguments.
 * @return: (unknown) The parsed JSON result.
 */
function convexRun(fn: string, args: Record<string, unknown>): unknown {
  const out = execFileSync(
    "npx",
    ["convex", "run", fn, JSON.stringify(args), "--identity", JSON.stringify(DEV_IDENTITY)],
    { cwd: BACKEND_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
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

/**
 * purpose: Create the dev household once and print join codes.
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

/**
 * purpose: Start verifying the dev caregiver's phone number; Sunny texts the code.
 * @param number: (string) Number as typed.
 */
function startPhone(number: string): void {
  const state = loadState();
  const result = convexRun("households:setMyPhone", {
    householdId: state.householdId,
    phone: number,
  }) as { phone: string; expiresAt: number };
  console.log(
    `Texted a code to ${result.phone}; it expires at ${new Date(result.expiresAt).toLocaleTimeString()}. ` +
      "Run `confirm-phone <code>` next.",
  );
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
    case "google":
      google();
      break;
    case "phone":
      if (!rest[0]) throw new Error("Usage: phone <number>");
      startPhone(rest.join(" "));
      break;
    case "confirm-phone":
      if (!rest[0]) throw new Error("Usage: confirm-phone <code>");
      confirmPhone(rest[0]);
      break;
    default:
      console.log(
        'Commands: setup | chat "<message>" [--continue] | day | codes | google | phone <number> | confirm-phone <code>',
      );
  }
}

await main(process.argv.slice(2));
