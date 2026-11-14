// lib/deviceWording.test.ts
// Purpose: Unit tests for the senior-surface wording ported from the app
// (lib/deviceWording.ts), with the app's own cases (sunny_app/src/day/__tests__/format.test.ts
// clockTime and relativeDayName, sunny_app/src/display/__tests__/cue.test.ts spokenTime,
// cueSpeech and hasWrittenPrompt, display/__tests__/model.test.ts fullDate) plus the Done
// question and the task icons.
//
// Last modified: 2026-11-13

import { describe, expect, it } from "vitest";
import {
  clockTime,
  cueSpeech,
  doneQuestion,
  fullDate,
  hasWrittenPrompt,
  relativeDayName,
  spokenTime,
  taskIcon,
} from "./deviceWording";
import type { SpeechTask } from "./deviceWording";

/**
 * purpose: Build a task for the cue sentence.
 * @param overrides: (Partial<SpeechTask>) Fields to set.
 * @return: (SpeechTask) An 08:00 medication with the backend's default prompt unless overridden.
 */
function speechTask(overrides: Partial<SpeechTask> = {}): SpeechTask {
  return {
    type: "medication",
    displayLabel: "Morning pills",
    spokenPrompt: "Time for Morning pills.",
    scheduledTime: "08:00",
    ...overrides,
  };
}

describe("clockTime", () => {
  it("writes 12-hour times without AM or PM", () => {
    expect(clockTime("08:00")).toBe("8:00");
    expect(clockTime("14:30")).toBe("2:30");
    expect(clockTime("00:15")).toBe("12:15");
    expect(clockTime("12:00")).toBe("12:00");
  });

  it("reads Anytime for the anytime sentinel and leaves bad input alone", () => {
    expect(clockTime("anytime")).toBe("Anytime");
    expect(clockTime("25:00")).toBe("25:00");
  });
});

describe("relativeDayName", () => {
  it("names today, tomorrow and later days", () => {
    expect(relativeDayName("2026-10-26", "2026-10-26")).toBe("Today");
    expect(relativeDayName("2026-10-27", "2026-10-26")).toBe("Tomorrow");
    expect(relativeDayName("2026-10-29", "2026-10-26")).toBe("Thursday");
  });

  it("counts Tomorrow across a month boundary", () => {
    expect(relativeDayName("2026-11-01", "2026-10-31")).toBe("Tomorrow");
  });

  it("is null when the dates cannot be compared", () => {
    expect(relativeDayName("soon", "2026-10-26")).toBeNull();
    expect(relativeDayName("2026-13-45", "2026-10-26")).toBeNull();
  });
});

describe("fullDate", () => {
  it("adds the year to the date label", () => {
    expect(fullDate("November 7", "2026-11-07")).toBe("November 7, 2026");
  });
});

describe("spokenTime", () => {
  it("says o'clock on the hour", () => {
    expect(spokenTime("08:00")).toBe("8 o'clock");
    expect(spokenTime("12:00")).toBe("12 o'clock");
  });

  it("reads other times as a clock", () => {
    expect(spokenTime("14:30")).toBe("2:30");
  });
});

describe("cueSpeech", () => {
  it("speaks the caregiver-written prompt exactly", () => {
    const task = speechTask({ spokenPrompt: "  Time for your pills, the small white ones.  " });
    expect(cueSpeech(task)).toBe("Time for your pills, the small white ones.");
  });

  it("uses the medication template when the prompt is the default", () => {
    expect(cueSpeech(speechTask())).toBe(
      "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.",
    );
  });

  it("uses the finished template for other tasks and for a blank prompt", () => {
    const task = speechTask({
      type: "routine",
      displayLabel: "Walk",
      spokenPrompt: " ",
      scheduledTime: "15:30",
    });
    expect(cueSpeech(task)).toBe("Time for Walk, at 3:30. Press Done when you have finished.");
  });
});

describe("hasWrittenPrompt", () => {
  it("treats only the backend default and blank as unwritten", () => {
    expect(hasWrittenPrompt(speechTask())).toBe(false);
    expect(hasWrittenPrompt(speechTask({ spokenPrompt: "" }))).toBe(false);
    expect(hasWrittenPrompt(speechTask({ spokenPrompt: "Time for Evening pills." }))).toBe(true);
  });
});

describe("doneQuestion and taskIcon", () => {
  it("asks about medication differently", () => {
    expect(doneQuestion("medication")).toBe("Taken them?");
    expect(doneQuestion("routine")).toBe("Finished?");
  });

  it("names one icon per task type", () => {
    expect(
      (["medication", "appointment", "checklist", "reminder", "routine"] as const).map(taskIcon),
    ).toEqual(["pills", "calendar", "checklist", "bell", "clock"]);
  });
});
