import type { Doc, Id } from "../_generated/dataModel";
import type { ActivityPhone, ActivityRow } from "./liveActivity";
import type { ActivityContent, LiveActivityPhase } from "./validators";

export const MIN = 60_000;

export const WINDOW_START = Date.parse("2026-11-19T13:00:00Z");

export const WINDOW_END = WINDOW_START + 60 * MIN;

export const INSTANCE_ID = "jd7c4zq9x2m5k8v1b3n6h0w4t6s2r8ya" as Id<"taskInstances">;

export const ACTIVITY_KEY = "k97f2ea1p6d8s3m5x7c9v2b4n6q8w0zt";

export const UPDATE_TOKEN = "ab".repeat(80);

export const PHONE_USER_ID = "user_2phoneQ7dM4xV9bN1cK5hW0tS3r";

export const PHONE: ActivityPhone = { userId: PHONE_USER_ID, canConfirm: true };

const TASK_ID = "j57dq2m8v4x6b9n1c3k5h7w0t2s4r6ye" as Id<"tasks">;

const HOUSEHOLD_ID = "jn7a1b2c3d4e5f6g7h8j9k0m1n2p3q4r" as Id<"households">;

export const SHOWER_STEPS = ["Turn on the water.", "Wash and rinse.", "Dry off and dress."];

export function taskDoc(fields: Partial<Doc<"tasks">> = {}): Doc<"tasks"> {
  return {
    _id: TASK_ID,
    _creationTime: WINDOW_START - 24 * 60 * MIN,
    householdId: HOUSEHOLD_ID,
    type: "medication",
    title: "Morning pills",
    displayLabel: "Morning pills",
    spokenPrompt: "It's 8 o'clock. Time for your morning pills, the small white ones.",
    screenSentence: "Take your morning pills.",
    pillDescription: "the small white ones",
    checklistItems: [],
    times: ["08:00"],
    windowMinutes: 60,
    highPriority: false,
    createdByKind: "caregiver",
    active: true,
    scheduleChangedAt: WINDOW_START - 24 * 60 * MIN,
    ...fields,
  };
}

export function showerTask(fields: Partial<Doc<"tasks">> = {}): Doc<"tasks"> {
  const { pillDescription: _pills, ...task } = taskDoc();
  return {
    ...task,
    type: "routine",
    title: "Shower",
    displayLabel: "Shower",
    spokenPrompt: "Time for your shower.",
    screenSentence: "Take your shower.",
    checklistItems: SHOWER_STEPS,
    ...fields,
  };
}

export function instanceDoc(fields: Partial<Doc<"taskInstances">> = {}): Doc<"taskInstances"> {
  return {
    _id: INSTANCE_ID,
    _creationTime: WINDOW_START - 24 * 60 * MIN,
    taskId: TASK_ID,
    householdId: HOUSEHOLD_ID,
    localDate: "2026-11-19",
    scheduledTime: "08:00",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    state: "due",
    createdAt: WINDOW_START - 24 * 60 * MIN,
    firedSteps: [],
    ...fields,
  };
}

export function rowOf(phase: LiveActivityPhase, shown: ActivityContent): ActivityRow {
  return { phase, shown };
}

export function livePhase(acceptedAt: number = WINDOW_START): LiveActivityPhase {
  return { kind: "live", acceptedAt, updateToken: UPDATE_TOKEN, tokenAt: acceptedAt + 2_000 };
}
