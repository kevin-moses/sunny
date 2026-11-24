import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

function makeBackend() {
  return convexTest(schema, modules);
}

type TestConvex = ReturnType<typeof makeBackend>;

interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
}

async function setup(): Promise<Fixture> {
  const t = makeBackend();
  const pat = t.withIdentity({ subject: "pat" });
  const householdId = await pat.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    caregiverDisplayName: "Pat",
  });
  for (const [user, grants] of [
    ["max", "caregiver_member"],
    ["val", "caregiver_viewer"],
    ["phone", "senior_phone"],
  ] as const) {
    const { code } = await pat.mutation(api.households.createJoinCode, { householdId, grants });
    if (grants === "senior_phone") {
      await t.mutation(internal.households.pairDevice, { code, userId: user });
    } else {
      await t.withIdentity({ subject: user }).mutation(api.households.redeemJoinCode, { code });
    }
  }
  return { t, householdId };
}

function base(f: Fixture) {
  return {
    householdId: f.householdId,
    type: "routine" as const,
    title: "Walk",
    displayLabel: "Walk",
    times: ["09:00"],
  };
}

describe("tasks.create", () => {
  test("creates a task with defaults, a default spoken prompt and the caller as creator", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const id = await pat.mutation(api.tasks.create, {
      ...base(f),
      title: "  Morning pills (lisinopril)  ",
      displayLabel: "Morning pills",
      type: "medication",
    });
    const tasks = await pat.query(api.tasks.list, { householdId: f.householdId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      _id: id,
      title: "Morning pills (lisinopril)",
      spokenPrompt: "Time for Morning pills.",
      windowMinutes: 60,
      checklistItems: [],
      active: true,
      createdByKind: "caregiver",
      createdBy: "pat",
      highPriority: false,
    });
  });

  test("stores a trimmed screen sentence and treats a blank one as absent", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    await pat.mutation(api.tasks.create, {
      ...base(f),
      screenSentence: "  Go for a walk.  ",
    });
    await pat.mutation(api.tasks.create, {
      ...base(f),
      title: "Read",
      displayLabel: "Read",
      screenSentence: "   ",
    });
    const tasks = await pat.query(api.tasks.list, { householdId: f.householdId });
    expect(tasks.map((task) => task.screenSentence)).toEqual(["Go for a walk.", undefined]);
  });

  test("keeps an explicit spoken prompt and sorts times", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    await pat.mutation(api.tasks.create, {
      ...base(f),
      spokenPrompt: "Time for a walk, dear.",
      times: ["15:00", "09:00"],
    });
    const [task] = await pat.query(api.tasks.list, { householdId: f.householdId });
    expect(task).toMatchObject({
      spokenPrompt: "Time for a walk, dear.",
      times: ["09:00", "15:00"],
    });
  });

  test("audits the insert with the display label and creator kind", async () => {
    const f = await setup();
    const id = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, base(f));
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const row = rows.find((r) => r.entity === "task");
    expect(row).toMatchObject({
      action: "insert",
      entityId: id,
      actorKind: "caregiver",
      actorUserId: "pat",
      detail: { displayLabel: "Walk", createdByKind: "caregiver" },
    });
  });

  test("rejects each invalid combination", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["blank title", { title: "  " }],
      ["blank label", { displayLabel: "" }],
      ["title over 200", { title: "t".repeat(201) }],
      ["label over 60", { displayLabel: "l".repeat(61) }],
      ["bad time", { times: ["9:00"] }],
      ["duplicate times", { times: ["09:00", "09:00"] }],
      ["weekday 0", { daysOfWeek: [0, 1] }],
      ["weekday 8", { daysOfWeek: [8] }],
      ["fractional weekday", { daysOfWeek: [1.5] }],
      ["once-on with weekdays", { onceOn: "2027-03-22", daysOfWeek: [1] }],
      ["bad once-on", { onceOn: "2027-02-30" }],
      ["ends before starts", { startsOn: "2027-03-22", endsOn: "2027-03-21" }],
      ["window 0", { windowMinutes: 0 }],
      ["window 721", { windowMinutes: 721 }],
      ["fractional window", { windowMinutes: 30.5 }],
      ["max per day 0", { asNeededMaxPerDay: 0 }],
      ["min hours 0", { asNeededMinHours: 0 }],
    ];
    for (const [name, extra] of cases) {
      await expect(
        pat.mutation(api.tasks.create, { ...base(f), ...extra }),
        name,
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
  });

  test("accepts boundary values", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    await expect(
      pat.mutation(api.tasks.create, {
        ...base(f),
        windowMinutes: 720,
        daysOfWeek: [1, 7],
        startsOn: "2027-03-22",
        endsOn: "2027-03-22",
        times: ["00:00", "23:59"],
        asNeededMaxPerDay: 1,
        asNeededMinHours: 0.5,
      }),
    ).resolves.toBeDefined();
    await expect(
      pat.mutation(api.tasks.create, { ...base(f), windowMinutes: 1 }),
    ).resolves.toBeDefined();
  });

  test("stores high priority when given", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const id = await pat.mutation(api.tasks.create, { ...base(f), highPriority: true });
    const task = await f.t.run(async (ctx) => await ctx.db.get(id));
    expect(task!.highPriority).toBe(true);
  });

  test("access: outsiders, viewers and devices cannot create; members can", async () => {
    const f = await setup();
    for (const subject of ["nobody", "val", "phone"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.tasks.create, base(f)),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    await expect(
      f.t.withIdentity({ subject: "max" }).mutation(api.tasks.create, base(f)),
    ).resolves.toBeDefined();
  });
});

describe("tasks.list", () => {
  test("readers (caregivers of any role and the device) see tasks; outsiders do not", async () => {
    const f = await setup();
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, base(f));
    for (const subject of ["pat", "max", "val", "phone"]) {
      const rows = await f.t
        .withIdentity({ subject })
        .query(api.tasks.list, { householdId: f.householdId });
      expect(rows, subject).toHaveLength(1);
    }
    await expect(
      f.t.withIdentity({ subject: "nobody" }).query(api.tasks.list, { householdId: f.householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("tasks.update", () => {
  test("changes fields, keeps the rest, and null clears optional fields", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const taskId = await pat.mutation(api.tasks.create, {
      ...base(f),
      daysOfWeek: [1, 3],
      pillDescription: "small white",
      asNeededMaxPerDay: 2,
      highPriority: true,
    });
    await pat.mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      displayLabel: "Stroll",
      daysOfWeek: null,
      pillDescription: null,
      asNeededMaxPerDay: null,
    });
    const [task] = await pat.query(api.tasks.list, { householdId: f.householdId });
    expect(task).toMatchObject({ title: "Walk", displayLabel: "Stroll", times: ["09:00"] });
    expect(task!.daysOfWeek).toBeUndefined();
    expect(task!.pillDescription).toBeUndefined();
    expect(task!.asNeededMaxPerDay).toBeUndefined();
    expect(task!.highPriority).toBe(true);
  });

  test("turns high priority on and off", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const taskId = await pat.mutation(api.tasks.create, base(f));
    const priority = async () =>
      (await f.t.run(async (ctx) => await ctx.db.get(taskId)))!.highPriority;
    await pat.mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      highPriority: true,
    });
    expect(await priority()).toBe(true);
    await pat.mutation(api.tasks.update, { householdId: f.householdId, taskId, title: "Stroll" });
    expect(await priority()).toBe(true);
    await pat.mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      highPriority: false,
    });
    expect(await priority()).toBe(false);
  });

  test("a blank spoken prompt is restored from the label", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const taskId = await pat.mutation(api.tasks.create, { ...base(f), spokenPrompt: "Custom." });
    await pat.mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      spokenPrompt: "  ",
      displayLabel: "Stroll",
    });
    const [task] = await pat.query(api.tasks.list, { householdId: f.householdId });
    expect(task!.spokenPrompt).toBe("Time for Stroll.");
  });

  describe("screen sentence", () => {
    async function withSentence() {
      const f = await setup();
      const pat = f.t.withIdentity({ subject: "pat" });
      const taskId = await pat.mutation(api.tasks.create, {
        ...base(f),
        screenSentence: "Go for a walk.",
      });
      const sentence = async () =>
        (await pat.query(api.tasks.list, { householdId: f.householdId }))[0]!.screenSentence;
      return { f, pat, taskId, sentence };
    }

    test("a new display label clears it", async () => {
      const { f, pat, taskId, sentence } = await withSentence();
      await pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId,
        displayLabel: "Stroll",
      });
      expect(await sentence()).toBeUndefined();
    });

    test("a new display label with a new sentence keeps the new sentence", async () => {
      const { f, pat, taskId, sentence } = await withSentence();
      await pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId,
        displayLabel: "Stroll",
        screenSentence: "Take a stroll.",
      });
      expect(await sentence()).toBe("Take a stroll.");
    });

    test("the same display label, or other changes, keep it", async () => {
      const { f, pat, taskId, sentence } = await withSentence();
      await pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId,
        displayLabel: " Walk ",
      });
      await pat.mutation(api.tasks.update, { householdId: f.householdId, taskId, title: "Stroll" });
      expect(await sentence()).toBe("Go for a walk.");
    });

    test("an empty or blank sentence clears it", async () => {
      const { f, pat, taskId, sentence } = await withSentence();
      await pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId,
        screenSentence: "",
      });
      expect(await sentence()).toBeUndefined();
    });

    test("a sentence over the cap is refused on create and update, and the cap itself is accepted", async () => {
      const { f, pat, taskId } = await withSentence();
      const longest = "x".repeat(60);
      await pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId,
        screenSentence: longest,
      });
      await expect(
        pat.mutation(api.tasks.update, {
          householdId: f.householdId,
          taskId,
          screenSentence: `${longest}x`,
        }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
      await expect(
        pat.mutation(api.tasks.create, { ...base(f), screenSentence: `${longest}x` }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    });
  });

  test("validates the merged task, not just the changed fields", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const taskId = await pat.mutation(api.tasks.create, { ...base(f), daysOfWeek: [1] });
    await expect(
      pat.mutation(api.tasks.update, { householdId: f.householdId, taskId, onceOn: "2027-03-22" }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      pat.mutation(api.tasks.update, { householdId: f.householdId, taskId, title: " " }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("audits the update", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const taskId = await pat.mutation(api.tasks.create, base(f));
    await pat.mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      displayLabel: "Stroll",
    });
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(rows.filter((r) => r.entity === "task").map((r) => r.action)).toEqual([
      "insert",
      "update",
    ]);
    expect(rows[1]!.detail["displayLabel"]).toBe("Stroll");
  });

  test("a task of another household is not found", async () => {
    const f = await setup();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    const taskId = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, base(f));
    await expect(
      xen.mutation(api.tasks.update, { householdId: other, taskId, title: "Hacked" }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("access: outsiders, viewers and devices cannot update", async () => {
    const f = await setup();
    const taskId = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, base(f));
    for (const subject of ["nobody", "val", "phone"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.tasks.update, { householdId: f.householdId, taskId, title: "x" }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("tasks.remove", () => {
  test("hard deletes the task and audits the deletion", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const taskId = await pat.mutation(api.tasks.create, base(f));
    await pat.mutation(api.tasks.remove, { householdId: f.householdId, taskId });
    expect(await pat.query(api.tasks.list, { householdId: f.householdId })).toHaveLength(0);
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(rows.filter((r) => r.entity === "task").map((r) => r.action)).toEqual([
      "insert",
      "delete",
    ]);
  });

  test("the purge removes the task's instances and notifications in the background", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const taskId = await pat.mutation(api.tasks.create, base(f));
    const before = await f.t.run(
      async (ctx) => (await ctx.db.query("taskInstances").collect()).length,
    );
    expect(before).toBeGreaterThan(0);
    await pat.mutation(api.tasks.remove, { householdId: f.householdId, taskId });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await f.t.run(async (ctx) => (await ctx.db.query("taskInstances").collect()).length),
    ).toBe(0);
  });

  test("access: outsiders, viewers and devices cannot delete", async () => {
    const f = await setup();
    const taskId = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, base(f));
    for (const subject of ["nobody", "val", "phone"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.tasks.remove, { householdId: f.householdId, taskId }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("size caps", () => {
  test("renaming to a label over 60 or a title over 200 is refused", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const id = await pat.mutation(api.tasks.create, base(f));
    await expect(
      pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId: id,
        displayLabel: "x".repeat(61),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId: id,
        title: "x".repeat(201),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test.each([
    [
      "25 times",
      { times: Array.from({ length: 25 }, (_, i) => `${String(i).padStart(2, "0")}:00`) },
    ],
    ["51 checklist items", { checklistItems: Array.from({ length: 51 }, () => "x") }],
    ["a 201 character checklist item", { checklistItems: ["x".repeat(201)] }],
    ["a 301 character spoken prompt", { spokenPrompt: "x".repeat(301) }],
    ["a 201 character pill description", { pillDescription: "x".repeat(201) }],
  ])("create refuses %s", async (_name, extra) => {
    const f = await setup();
    await expect(
      f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, { ...base(f), ...extra }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("create accepts the boundary sizes", async () => {
    const f = await setup();
    const times = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
      ...base(f),
      times,
      checklistItems: Array.from({ length: 50 }, () => "x".repeat(200)),
      spokenPrompt: "x".repeat(300),
      pillDescription: "x".repeat(200),
    });
  });

  test("update refuses an over-size list or text it writes", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const id = await pat.mutation(api.tasks.create, base(f));
    await expect(
      pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId: id,
        checklistItems: Array.from({ length: 51 }, () => "x"),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      pat.mutation(api.tasks.update, {
        householdId: f.householdId,
        taskId: id,
        spokenPrompt: "x".repeat(301),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });
});
