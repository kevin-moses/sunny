import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntryView, MemoryView, MessageView, TopicView } from "../convex/profile";
import { deploymentProblem, readEnvFile, type EnvSource } from "./devGuard";
import { cliError, loadProfile, parseProfileFile } from "./profileLoader";
import type { LoadReport } from "./profileLoader";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(SCRIPT_DIR, "..");
const STATE_FILE = join(SCRIPT_DIR, ".dev-state.json");
const POLL_MS = 2_000;
const GIVE_UP_MS = 35 * 60_000;

const DEV_IDENTITY = {
  subject: "user_sunny_dev_caregiver",
  issuer: "https://sunny.dev.local",
  name: "Dev Caregiver",
};

function envFile(name: string): EnvSource {
  const path = join(BACKEND_DIR, name);
  return existsSync(path) ? readEnvFile(readFileSync(path, "utf8")) : {};
}

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

interface DevState {
  householdId: string;
  lastRequestId?: string;
}

interface RequestView {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  reply: string | null;
  error: string | null;
}

const FINISHED_MESSAGES: Record<string, (view: RequestView) => string> = {
  succeeded: (view) => `\nSunny: ${view.reply}`,
  failed: (view) => `\nThe agent request failed: ${view.error}`,
  cancelled: () => "\nThe request was cancelled.",
};

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

function loadState(): DevState {
  if (!existsSync(STATE_FILE)) throw new Error("No dev household yet; run `setup` first.");
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DevState;
}

function saveState(state: DevState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

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

const INVITE_ROLES = ["primary", "member", "viewer"] as const;

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

function findExistingHousehold(): string | null {
  const mine = convexRun("households:mine", {}) as {
    households: Array<{ household: { _id: string } }>;
  };
  return mine.households[0]?.household._id ?? null;
}

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

function day(): void {
  const state = loadState();
  console.log(
    JSON.stringify(convexRun("calendar:dayView", { householdId: state.householdId }), null, 2),
  );
}

function google(): void {
  const state = loadState();
  const url = convexRun("googleOauth:connectUrl", {
    householdId: state.householdId,
    purpose: "calendar",
  });
  console.log(`Within 5 minutes, open this link once, in the browser you will sign in to Google with
(as a Google test user); the sign-in must finish in that same browser. The link works once:
do not paste it anywhere else, since a link preview would use it up.
${url}`);
}

const PHONE_WAIT_MS = 30_000;
const PHONE_POLL_MS = 1_000;

type PhoneStatus =
  | { status: "none" | "expired" | "sending" }
  | { status: "sent"; phone: string; expiresAt: number }
  | { status: "send_failed"; error: string };

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

const CONFIRM_MESSAGES: Record<string, (r: { phone?: string; attemptsLeft?: number }) => string> = {
  verified: (r) => `Verified ${r.phone}. Sunny can now text you.`,
  wrong_code: (r) => `Wrong code; ${r.attemptsLeft} attempts left.`,
  expired: () => "That code expired; run `phone <number>` for a new one.",
  locked: () => "Too many wrong codes; run `phone <number>` for a new one.",
  none: () => "No verification is pending; run `phone <number>` first.",
};

function confirmPhone(code: string): void {
  const state = loadState();
  const result = convexRun("households:confirmMyPhone", {
    householdId: state.householdId,
    code,
  }) as { status: string; phone?: string; attemptsLeft?: number };
  console.log((CONFIRM_MESSAGES[result.status] ?? (() => JSON.stringify(result)))(result));
}

function voiceAgentCommand(command: string | undefined, rest: string[]): boolean {
  const householdId = (): string => loadState().householdId;
  if (command === "list") {
    const list = convexRun("lists:get", { householdId: householdId() }) as {
      open: { text: string }[];
      done: { text: string }[];
    };
    console.log(list.open.length > 0 ? list.open.map((i) => `- ${i.text}`).join("\n") : "(empty)");
    if (list.done.length > 0) console.log(`Ticked: ${list.done.map((i) => i.text).join(", ")}`);
    return true;
  }
  if (command === "list-add") {
    const text = rest.join(" ");
    if (!text) throw new Error('Usage: list-add "<text>"');
    const result = convexRun("lists:add", { householdId: householdId(), text }) as {
      status: string;
    };
    console.log(result.status === "added" ? `Added: ${text}` : `Already on the list: ${text}`);
    return true;
  }
  if (command === "weather-location") {
    const weatherLocation = rest.join(" ");
    convexRun("households:update", { householdId: householdId(), weatherLocation });
    console.log(
      weatherLocation ? `Weather location: ${weatherLocation}` : "Weather location cleared",
    );
    return true;
  }
  return false;
}

const OUTCOME_LINES: Array<[keyof Omit<LoadReport, "failed">, string, string]> = [
  ["added", "Added", ""],
  ["unchanged", "Unchanged", " (already stored)"],
  ["confirmed", "Confirmed", " (Sunny had heard this; now confirmed)"],
  ["updated", "Updated", " (replaced by the file's text)"],
  ["differs", "Differs", " (stored with other text, NOT updated; rerun with --update)"],
];

async function profileLoad(path: string, update: boolean): Promise<void> {
  const file = parseProfileFile(JSON.parse(readFileSync(path, "utf8")));
  const report = await loadProfile(file, loadState().householdId, convexRun, { update });
  for (const [key, label, note] of OUTCOME_LINES) {
    for (const item of report[key]) console.log(`${label.padEnd(9)} ${item}${note}`);
  }
  for (const { item, error } of report.failed)
    console.log(`${"Failed".padEnd(9)} ${item}: ${error}`);
  const counts = OUTCOME_LINES.map(([key]) => `${report[key].length} ${key}`);
  console.log(`\n${[...counts, `${report.failed.length} failed`].join(", ")}.`);
  if (report.failed.length > 0 || report.differs.length > 0) process.exitCode = 1;
}

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

function message(body: string): void {
  convexRun("profile:sendMessage", { householdId: loadState().householdId, body });
  console.log("Sent.");
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== undefined) requireDevDeployment();
  if (voiceAgentCommand(command, rest)) return;
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
