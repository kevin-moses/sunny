// tasks.test.ts
// Purpose: Tests for tasks.ts: task create, update, list and hard delete with the validation
// the SQL CHECK constraints performed, the default spoken prompt, null-clearing of optional
// fields, audit rows, and escalation policy list, create, rename, step edits and delete
// (seeded policies protected, deleting a custom policy clears it from tasks). One access test
// per public function: outsiders forbidden, viewers read but cannot write, devices read only.
//
// Last modified: 2026-10-28

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  return convexTest(schema, modules);
}

/** The convex-test harness type. */
type TestConvex = ReturnType<typeof makeBackend>;

/** Household with Pat (primary), Max (member), Val (viewer) and a paired device. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  medication: Id<"escalationPolicies">;
}

/**
 * purpose: Build the standard fixture.
 * @return: (Promise<Fixture>) The fixture.
 */
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
  const policies = await pat.query(api.tasks.listPolicies, { householdId });
  return { t, householdId, medication: policies.find((p) => p.systemKey === "medication")!._id };
}

/** Minimal valid arguments for tasks.create. */
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
      escalationPolicyId: f.medication,
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
      escalationPolicyId: f.medication,
    });
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

  test("rejects a policy from another household", async () => {
    const f = await setup();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    const [policy] = await xen.query(api.tasks.listPolicies, { householdId: other });
    await expect(
      f.t
        .withIdentity({ subject: "pat" })
        .mutation(api.tasks.create, { ...base(f), escalationPolicyId: policy!._id }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
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
      escalationPolicyId: f.medication,
    });
    await pat.mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      displayLabel: "Stroll",
      daysOfWeek: null,
      pillDescription: null,
      asNeededMaxPerDay: null,
      escalationPolicyId: null,
    });
    const [task] = await pat.query(api.tasks.list, { householdId: f.householdId });
    expect(task).toMatchObject({ title: "Walk", displayLabel: "Stroll", times: ["09:00"] });
    expect(task!.daysOfWeek).toBeUndefined();
    expect(task!.pillDescription).toBeUndefined();
    expect(task!.asNeededMaxPerDay).toBeUndefined();
    expect(task!.escalationPolicyId).toBeUndefined();
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

describe("escalation policies", () => {
  const steps = [
    { offsetMinutes: 0, action: "prompt_senior" as const, skipIfClaimed: false },
    { offsetMinutes: 20, action: "alert_on_call" as const, skipIfClaimed: false },
  ];

  test("listPolicies returns the two seeded policies to every reader", async () => {
    const f = await setup();
    for (const subject of ["pat", "val", "phone"]) {
      const rows = await f.t
        .withIdentity({ subject })
        .query(api.tasks.listPolicies, { householdId: f.householdId });
      expect(rows.map((p) => p.name).sort(), subject).toEqual(["Medication", "Prompt only"]);
    }
    await expect(
      f.t
        .withIdentity({ subject: "nobody" })
        .query(api.tasks.listPolicies, { householdId: f.householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("creates a custom policy and rejects blank, duplicate and invalid-offset input", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const id = await pat.mutation(api.tasks.createPolicy, {
      householdId: f.householdId,
      name: " Gentle ",
      steps,
    });
    const rows = await pat.query(api.tasks.listPolicies, { householdId: f.householdId });
    expect(rows.find((p) => p._id === id)).toMatchObject({ name: "Gentle", steps });
    const cases: Array<[string, { name: string; steps: typeof steps }]> = [
      ["blank", { name: " ", steps }],
      ["duplicate", { name: "Medication", steps }],
      ["negative offset", { name: "A", steps: [{ ...steps[0]!, offsetMinutes: -1 }] }],
      ["fractional offset", { name: "B", steps: [{ ...steps[0]!, offsetMinutes: 1.5 }] }],
    ];
    for (const [name, bad] of cases) {
      await expect(
        pat.mutation(api.tasks.createPolicy, { householdId: f.householdId, ...bad }),
        name,
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
  });

  test("a policy may be created with no steps", async () => {
    const f = await setup();
    await expect(
      f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.createPolicy, {
        householdId: f.householdId,
        name: "Silent",
        steps: [],
      }),
    ).resolves.toBeDefined();
  });

  test("seeded policies may be renamed and tuned but keep their systemKey", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    await pat.mutation(api.tasks.updatePolicy, {
      householdId: f.householdId,
      policyId: f.medication,
      name: "Pills",
      steps,
    });
    const row = (await pat.query(api.tasks.listPolicies, { householdId: f.householdId })).find(
      (p) => p._id === f.medication,
    );
    expect(row).toMatchObject({ name: "Pills", systemKey: "medication", steps });
  });

  test("renaming to another policy's name is rejected; keeping its own name is fine", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    await expect(
      pat.mutation(api.tasks.updatePolicy, {
        householdId: f.householdId,
        policyId: f.medication,
        name: "Prompt only",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      pat.mutation(api.tasks.updatePolicy, {
        householdId: f.householdId,
        policyId: f.medication,
        name: "Medication",
      }),
    ).resolves.toBeNull();
  });

  test("seeded policies cannot be deleted", async () => {
    const f = await setup();
    await expect(
      f.t
        .withIdentity({ subject: "pat" })
        .mutation(api.tasks.removePolicy, { householdId: f.householdId, policyId: f.medication }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("deleting a custom policy clears it from the tasks that used it", async () => {
    const f = await setup();
    const pat = f.t.withIdentity({ subject: "pat" });
    const policyId = await pat.mutation(api.tasks.createPolicy, {
      householdId: f.householdId,
      name: "Gentle",
      steps,
    });
    const taskId = await pat.mutation(api.tasks.create, {
      ...base(f),
      escalationPolicyId: policyId,
    });
    await pat.mutation(api.tasks.removePolicy, { householdId: f.householdId, policyId });
    const [task] = await pat.query(api.tasks.list, { householdId: f.householdId });
    expect(task!._id).toBe(taskId);
    expect(task!.escalationPolicyId).toBeUndefined();
    const rows = await pat.query(api.tasks.listPolicies, { householdId: f.householdId });
    expect(rows.some((p) => p._id === policyId)).toBe(false);
  });

  test("a policy of another household is not found", async () => {
    const f = await setup();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await expect(
      xen.mutation(api.tasks.removePolicy, { householdId: other, policyId: f.medication }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("access: outsiders, viewers and devices cannot write policies", async () => {
    const f = await setup();
    for (const subject of ["nobody", "val", "phone"]) {
      const as = f.t.withIdentity({ subject });
      const args = { householdId: f.householdId };
      await expect(
        as.mutation(api.tasks.createPolicy, { ...args, name: "x", steps }),
        `${subject} create`,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
      await expect(
        as.mutation(api.tasks.updatePolicy, { ...args, policyId: f.medication, name: "x" }),
        `${subject} update`,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
      await expect(
        as.mutation(api.tasks.removePolicy, { ...args, policyId: f.medication }),
        `${subject} remove`,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});
