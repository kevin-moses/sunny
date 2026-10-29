// scripts/caregiver.ts
// Purpose: Command-line stand-in for the caregiver app against a Convex dev deployment.
// Calls the backend's public functions through `npx convex run <fn> <json> --identity <json>`
// as a fixed dev caregiver (a made-up Clerk user id; the dev deployment trusts the CLI's
// admin identity, so no sign-in is needed). The household id and the last request id are
// kept in scripts/.dev-state.json (git-ignored). Not part of the deployed backend.
//
//   setup              Create a dev household (once) with the dev caregiver as primary, and
//                      print join codes for the senior phone and the home display.
//   chat "<message>"   Send a request to the household agent (agentRequests:request), then
//                      poll agentRequests:get every 2 seconds and print the reply or error.
//                      Add --continue to continue the previous conversation.
//   day                Print the day view (calendar:dayView) as the displays see it.
//   codes              Print fresh join codes for the senior phone and the home display.
//
// Usage (from sunny_backend/, with `npx convex dev` configured for the dev deployment):
//   npx tsx scripts/caregiver.ts setup
//   npx tsx scripts/caregiver.ts chat "Add lunch with Sarah on Friday at noon"
//   npx tsx scripts/caregiver.ts chat "Make it 12:30 instead" --continue
//   npx tsx scripts/caregiver.ts day
//
// Last modified: 2026-10-29

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), ".dev-state.json");
const POLL_MS = 2_000;
const GIVE_UP_MS = 35 * 60_000;

/** The fixed dev caregiver, as the Clerk-style identity `convex run --identity` accepts. */
const DEV_IDENTITY = {
  subject: "user_sunny_dev_caregiver",
  issuer: "https://sunny.dev.local",
  name: "Dev Caregiver",
};

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
    if (view.status === "succeeded") {
      console.log(`\nSunny: ${view.reply}`);
      return;
    }
    if (view.status === "failed") {
      console.log(`\nThe agent request failed: ${view.error}`);
      return;
    }
    if (view.status === "cancelled") {
      console.log("\nThe request was cancelled.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.log("Still running after 35 minutes; check agentRequests in the dashboard.");
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
 * purpose: Dispatch the command line.
 * @param argv: (string[]) Arguments after the script name.
 * @return: (Promise<void>) Resolves when the command finishes.
 */
async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
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
    default:
      console.log('Commands: setup | chat "<message>" [--continue] | day | codes');
  }
}

await main(process.argv.slice(2));
