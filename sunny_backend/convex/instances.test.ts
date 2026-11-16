import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  UNDO_WINDOW_MS,
  confirmDueTaskCore,
  confirmInstance,
  logDoseCore,
  snoozeInstance,
} from "./instances";
import { executeAgentTool } from "./lib/agentTools";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const AGENT = { kind: "agent" } as const;

function makeBackend() {
  const t = convexTest(schema, modules);
  workpoolTest.register(t, "deliveryPool");
  return t;
}

type TestConvex = ReturnType<typeof makeBackend>;

interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  phone: Id<"devices">;
  display: Id<"devices">;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

function at(iso: string): number {
  vi.setSystemTime(new Date(iso));
  return Date.parse(iso);
}

async function pair(
  t: TestConvex,
  householdId: Id<"households">,
  asOwner: ReturnType<TestConvex["withIdentity"]>,
  userId: string,
  grants: "senior_phone" | "home_display",
): Promise<Id<"devices">> {
  const { code } = await asOwner.mutation(api.households.createJoinCode, { householdId, grants });
  return (await t.mutation(internal.households.pairDevice, { code, userId })).deviceId;
}

async function setup(iso: string): Promise<Fixture> {
  at(iso);
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
  ] as const) {
    const { code } = await pat.mutation(api.households.createJoinCode, { householdId, grants });
    await t.withIdentity({ subject: user }).mutation(api.households.redeemJoinCode, { code });
  }
  const phone = await pair(t, householdId, pat, "phone", "senior_phone");
  const display = await pair(t, householdId, pat, "display", "home_display");
  return { t, householdId, phone, display };
}

async function makeTask(f: Fixture, title: string, times: string[]): Promise<Id<"tasks">> {
  return await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
    householdId: f.householdId,
    type: "medication",
    title,
    displayLabel: title,
    times,
  });
}

async function instancesOn(f: Fixture, date: string) {
  const rows = await f.t.run(
    async (ctx) =>
      await ctx.db
        .query("taskInstances")
        .withIndex("by_household_date", (q) =>
          q.eq("householdId", f.householdId).eq("localDate", date),
        )
        .collect(),
  );
  return rows.sort((a, b) => a.windowStart - b.windowStart);
}

async function tick(t: TestConvex, iso: string): Promise<void> {
  const ids = await t.run(async (ctx) =>
    (await ctx.db.query("households").collect()).map((h) => h._id),
  );
  for (const householdId of ids) {
    await t.mutation(internal.scheduler.tickHousehold, {
      householdId,
      now: Date.parse(iso),
    });
  }
}

async function confirmDetail(
  f: Fixture,
  instanceId: Id<"taskInstances">,
): Promise<Record<string, unknown> | undefined> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
  const row = rows.find((a) => {
    const to = (a.detail as { to?: unknown }).to;
    return (
      a.action === "state_change" &&
      a.entityId === instanceId &&
      (to === "confirmed" || to === "resolved")
    );
  });
  return row?.detail as Record<string, unknown> | undefined;
}

describe("confirmTaskInstance", () => {
  test("records that the confirm came through the app (transport app)", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: instance!._id, via: "phone_app" });
    expect(await confirmDetail(f, instance!._id)).toMatchObject({
      to: "confirmed",
      transport: "app",
    });
  });

  test("a device cannot confirm more than an hour early, the agent can at 30 minutes", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    await expect(
      asPhone.mutation(api.instances.confirmTaskInstance, {
        instanceId: instance!._id,
        via: "button",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid", message: "This task is not due yet" } });

    const confirmed = await f.t.run(
      async (ctx) =>
        await confirmInstance(
          ctx,
          AGENT,
          { instanceId: instance!._id, via: "voice" },
          Date.parse("2027-03-14T11:30:00Z"),
        ),
    );
    expect(confirmed).toMatchObject({
      state: "confirmed",
      confirmedAt: Date.parse("2027-03-14T11:30:00Z"),
      confirmedVia: "voice",
    });
  });

  test("confirming again keeps the first confirmation (already-done guard)", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const confirm = async (iso: string) =>
      await f.t.run(
        async (ctx) =>
          await confirmInstance(
            ctx,
            AGENT,
            { instanceId: instance!._id, via: "button" },
            Date.parse(iso),
          ),
      );
    await confirm("2027-03-14T11:30:00Z");
    const again = await confirm("2027-03-14T12:10:00Z");
    expect(again.confirmedAt).toBe(Date.parse("2027-03-14T11:30:00Z"));
  });

  test("a device within an hour confirms; an editor caregiver resolves under their name", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await makeTask(f, "Evening pills", ["08:30"]);
    const [first, second] = await instancesOn(f, "2027-03-14");
    const device = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: first!._id, via: "button" });
    expect(device).toMatchObject({
      state: "confirmed",
      confirmedBy: "phone",
      confirmedVia: "button",
    });

    const caregiver = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, {
        instanceId: second!._id,
        via: "phone_app",
        note: "Called her",
      });
    expect(caregiver).toMatchObject({
      state: "resolved",
      confirmedBy: "max",
      confirmedVia: "caregiver",
      resolutionNote: "Called her",
    });
  });

  test("a blank resolution note is stored as absent and a padded one is trimmed", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await makeTask(f, "Evening pills", ["08:30"]);
    const [first, second] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    const blank = await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: first!._id,
      via: "phone_app",
      note: "   ",
    });
    expect(blank.resolutionNote).toBeUndefined();
    const padded = await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: second!._id,
      via: "phone_app",
      note: "  Called her  ",
    });
    expect(padded.resolutionNote).toBe("Called her");
  });

  test("a resolution note over 500 characters is rejected", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await expect(
      f.t.withIdentity({ subject: "max" }).mutation(api.instances.confirmTaskInstance, {
        instanceId: instance!._id,
        via: "caregiver",
        note: "x".repeat(501),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("a paired device cannot confirm with via caregiver", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await expect(
      f.t.withIdentity({ subject: "phone" }).mutation(api.instances.confirmTaskInstance, {
        instanceId: instance!._id,
        via: "caregiver",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("the agent cannot confirm with via caregiver", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await expect(
      f.t.run(
        async (ctx) =>
          await confirmInstance(
            ctx,
            AGENT,
            { instanceId: instance!._id, via: "caregiver" },
            Date.parse("2027-03-14T11:30:00Z"),
          ),
      ),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("an editor caregiver resolves as caregiver whatever via they pass", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const done = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: instance!._id, via: "button" });
    expect(done).toMatchObject({ state: "resolved", confirmedVia: "caregiver" });
  });

  test("an editor resolves an upcoming task hours early while a device is refused", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const args = { instanceId: instance!._id, via: "button" as const };
    await expect(
      f.t.withIdentity({ subject: "phone" }).mutation(api.instances.confirmTaskInstance, args),
    ).rejects.toMatchObject({ data: { code: "invalid", message: "This task is not due yet" } });
    const done = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, args);
    expect(done).toMatchObject({
      state: "resolved",
      confirmedBy: "max",
      confirmedVia: "caregiver",
    });
  });

  test("an editor cannot resolve a later day's instance, but today's and yesterday's work", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [today] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    const day = 24 * 60 * 60 * 1000;
    const shifted = async (date: string, offset: number) =>
      await f.t.run(async (ctx) => {
        const id = await ctx.db.insert("taskInstances", {
          ...(({ _id, _creationTime, ...rest }) => rest)(today!),
          localDate: date,
          windowStart: today!.windowStart + offset * day,
          windowEnd: today!.windowEnd + offset * day,
        });
        return id;
      });
    const tomorrow = await shifted("2027-03-15", 1);
    const yesterday = await shifted("2027-03-13", -1);
    await expect(
      asMax.mutation(api.instances.confirmTaskInstance, { instanceId: tomorrow, via: "button" }),
    ).rejects.toMatchObject({ data: { code: "invalid", message: "This task is not due yet" } });
    expect(await f.t.run(async (ctx) => (await ctx.db.get(tomorrow))?.state)).toBe("upcoming");
    const upcomingToday = await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: today!._id,
      via: "button",
    });
    expect(upcomingToday.state).toBe("resolved");
    const carried = await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: yesterday,
      via: "button",
    });
    expect(carried.state).toBe("resolved");
  });

  test("the scheduler leaves an early-resolved task resolved after its window passes", async () => {
    const f = await setup("2027-03-14T10:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: instance!._id, via: "button" });
    await tick(f.t, "2027-03-14T12:00:00Z");
    await tick(f.t, "2027-03-14T23:00:00Z");
    const after = await f.t.run(async (ctx) => await ctx.db.get(instance!._id));
    expect(after?.state).toBe("resolved");
  });

  test("confirming clears a snooze", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:01:00Z");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    await asPhone.mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id });
    const done = await asPhone.mutation(api.instances.confirmTaskInstance, {
      instanceId: instance!._id,
      via: "button",
    });
    expect(done.snoozedUntil).toBeUndefined();
  });

  test("an unknown instance is not found", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t.run(async (ctx) => {
      await ctx.db.delete(instance!._id);
    });
    await expect(
      f.t.withIdentity({ subject: "pat" }).mutation(api.instances.confirmTaskInstance, {
        instanceId: instance!._id,
        via: "phone_app",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("access: outsiders, viewers and other households' devices are forbidden", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await pair(f.t, other, xen, "xdev", "senior_phone");
    const args = { instanceId: instance!._id, via: "phone_app" as const };
    for (const subject of ["nobody", "val", "xen", "xdev"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.instances.confirmTaskInstance, args),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    await expect(f.t.mutation(api.instances.confirmTaskInstance, args)).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });
});

describe("setTaskNote", () => {
  test("an editor sets a trimmed note, then a blank note clears it, each audited", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    const set = await asMax.mutation(api.instances.setTaskNote, {
      instanceId: instance!._id,
      note: "  Took with water  ",
    });
    expect(set.resolutionNote).toBe("Took with water");
    expect(set.state).toBe(instance!.state);
    const cleared = await asMax.mutation(api.instances.setTaskNote, {
      instanceId: instance!._id,
      note: "   ",
    });
    expect(cleared.resolutionNote).toBeUndefined();
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const notes = rows.filter((r) => r.action === "note" && r.entityId === instance!._id);
    expect(notes.map((r) => r.detail)).toEqual([{ hasNote: true }, { hasNote: false }]);
    expect(notes[0]!.actorUserId).toBe("max");
  });

  test("a note can be added to a done task", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asPat = f.t.withIdentity({ subject: "pat" });
    await asPat.mutation(api.instances.confirmTaskInstance, {
      instanceId: instance!._id,
      via: "caregiver",
    });
    const noted = await asPat.mutation(api.instances.setTaskNote, {
      instanceId: instance!._id,
      note: "Felt dizzy",
    });
    expect(noted).toMatchObject({ state: "resolved", resolutionNote: "Felt dizzy" });
  });

  test("a note over 500 characters is rejected", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await expect(
      f.t.withIdentity({ subject: "max" }).mutation(api.instances.setTaskNote, {
        instanceId: instance!._id,
        note: "x".repeat(501),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("access: viewers, devices and outsiders are forbidden", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    for (const subject of ["val", "phone", "display", "nobody"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.setTaskNote, { instanceId: instance!._id, note: "hi" }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });

  test("a primary of another household is forbidden", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t.withIdentity({ subject: "zed" }).mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/New_York",
      caregiverDisplayName: "Zed",
    });
    await expect(
      f.t
        .withIdentity({ subject: "zed" })
        .mutation(api.instances.setTaskNote, { instanceId: instance!._id, note: "hi" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("marking done without a note keeps the existing note; a new note replaces it", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await makeTask(f, "Evening pills", ["08:30"]);
    const [first, second] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    for (const instance of [first!, second!]) {
      await asMax.mutation(api.instances.setTaskNote, {
        instanceId: instance._id,
        note: "Refill soon",
      });
    }
    const kept = await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: first!._id,
      via: "caregiver",
    });
    expect(kept.resolutionNote).toBe("Refill soon");
    const replaced = await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: second!._id,
      via: "caregiver",
      note: "Done late",
    });
    expect(replaced.resolutionNote).toBe("Done late");
  });
});

describe("setTaskNote unchanged", () => {
  test("saving the same note again writes and audits nothing", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    const args = { instanceId: instance!._id, note: "Took with water" };
    await asMax.mutation(api.instances.setTaskNote, args);
    await asMax.mutation(api.instances.setTaskNote, { ...args, note: "  Took with water " });
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(rows.filter((r) => r.action === "note")).toHaveLength(1);
    await asMax.mutation(api.instances.setTaskNote, { instanceId: instance!._id });
    await asMax.mutation(api.instances.setTaskNote, { instanceId: instance!._id, note: " " });
    const after = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(after.filter((r) => r.action === "note")).toHaveLength(2);
  });
});

describe("undoResolve", () => {
  async function resolveAt(f: Fixture, iso: string): Promise<Id<"taskInstances">> {
    const [instance] = await instancesOn(f, "2027-03-14");
    at(iso);
    await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: instance!._id, via: "caregiver" });
    return instance!._id;
  }

  test("the same caregiver restores the state it had, per original state", async () => {
    const cases = [
      { name: "upcoming", resolve: "2027-03-14T11:00:00Z", ticks: [] as string[] },
      { name: "due", resolve: "2027-03-14T12:05:00Z", ticks: ["2027-03-14T12:00:00Z"] },
      { name: "missed", resolve: "2027-03-14T13:05:00Z", ticks: ["2027-03-14T13:00:00Z"] },
    ];
    for (const c of cases) {
      const f = await setup("2027-03-14T11:00:00Z");
      await makeTask(f, "Morning pills", ["08:00"]);
      for (const iso of c.ticks) await tick(f.t, iso);
      const id = await resolveAt(f, c.resolve);
      const undone = await f.t
        .withIdentity({ subject: "max" })
        .mutation(api.instances.undoResolve, { instanceId: id });
      expect(undone.state, c.name).toBe(c.name);
      expect(undone.confirmedAt).toBeUndefined();
      expect(undone.confirmedBy).toBeUndefined();
      expect(undone.confirmedVia).toBeUndefined();
      expect(undone.resolvedFromState).toBeUndefined();
    }
  });

  test("an escalated instance is restored as escalated", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(instance!._id, { state: "escalated" });
    });
    const id = await resolveAt(f, "2027-03-14T12:05:00Z");
    const undone = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.undoResolve, { instanceId: id });
    expect(undone.state).toBe("escalated");
  });

  test("falls back to due when the prior state was not recorded", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const id = await resolveAt(f, "2027-03-14T11:00:00Z");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(id, { resolvedFromState: undefined });
    });
    const undone = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.undoResolve, { instanceId: id });
    expect(undone.state).toBe("due");
  });

  test("keeps the note and the claim, and is audited as a state change", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    const asMax = f.t.withIdentity({ subject: "max" });
    at("2027-03-14T12:01:00Z");
    await asMax.mutation(api.instances.claimTaskInstance, { instanceId: instance!._id });
    await asMax.mutation(api.instances.setTaskNote, { instanceId: instance!._id, note: "Hi" });
    await resolveAt(f, "2027-03-14T12:05:00Z");
    const undone = await asMax.mutation(api.instances.undoResolve, { instanceId: instance!._id });
    expect(undone).toMatchObject({ state: "due", resolutionNote: "Hi", claimedBy: "max" });
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const last = rows.filter((r) => r.action === "state_change").at(-1);
    expect(last?.detail).toMatchObject({ from: "resolved", to: "due" });
    expect(last?.actorUserId).toBe("max");
  });

  test("works at exactly 30 seconds and is refused after", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const id = await resolveAt(f, "2027-03-14T11:00:00Z");
    const asMax = f.t.withIdentity({ subject: "max" });
    at("2027-03-14T11:00:31Z");
    await expect(
      asMax.mutation(api.instances.undoResolve, { instanceId: id }),
    ).rejects.toMatchObject({
      data: { code: "invalid", message: "This can no longer be undone." },
    });
    at("2027-03-14T11:00:30Z");
    const undone = await asMax.mutation(api.instances.undoResolve, { instanceId: id });
    expect(undone.state).toBe("upcoming");
  });

  test("works at exactly UNDO_WINDOW_MS after the resolve", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    at("2027-03-14T11:00:00Z");
    await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: instance!._id,
      via: "caregiver",
    });
    const t0 = (await f.t.run(async (ctx) => await ctx.db.get(instance!._id)))!.confirmedAt!;
    vi.setSystemTime(t0 + UNDO_WINDOW_MS);
    const undone = await asMax.mutation(api.instances.undoResolve, { instanceId: instance!._id });
    expect(undone.state).toBe("upcoming");
    vi.setSystemTime(t0 + UNDO_WINDOW_MS + 1);
    await asMax.mutation(api.instances.confirmTaskInstance, {
      instanceId: instance!._id,
      via: "caregiver",
    });
    vi.setSystemTime(t0 + 2 * UNDO_WINDOW_MS + 2);
    await expect(
      asMax.mutation(api.instances.undoResolve, { instanceId: instance!._id }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("restores the snooze the resolve cleared and audits the undo", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    const asMax = f.t.withIdentity({ subject: "max" });
    at("2027-03-14T12:01:00Z");
    await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id });
    const snoozed = (await f.t.run(async (ctx) => await ctx.db.get(instance!._id)))!.snoozedUntil;
    expect(snoozed).toBeDefined();
    await resolveAt(f, "2027-03-14T12:02:00Z");
    const resolved = await f.t.run(async (ctx) => await ctx.db.get(instance!._id));
    expect(resolved?.snoozedUntil).toBeUndefined();
    expect(resolved?.resolvedFromSnoozedUntil).toBe(snoozed);
    const undone = await asMax.mutation(api.instances.undoResolve, { instanceId: instance!._id });
    expect(undone.snoozedUntil).toBe(snoozed);
    expect(undone.resolvedFromSnoozedUntil).toBeUndefined();
    const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const stateChanges = rows.filter((r) => r.action === "state_change");
    expect(stateChanges.at(-1)?.detail).toMatchObject({ from: "resolved", to: "due", undo: true });
    expect(
      stateChanges.slice(0, -1).some((r) => (r.detail as Record<string, unknown>)["undo"]),
    ).toBe(false);
  });

  test("resolve, tick past the window start, undo, tick again: no step fires twice", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const id = await resolveAt(f, "2027-03-14T11:55:00Z");
    const get = async () => (await f.t.run(async (ctx) => await ctx.db.get(id)))!;
    await tick(f.t, "2027-03-14T12:00:00Z");
    expect((await get()).state).toBe("resolved");
    expect((await get()).firedSteps).toEqual([]);
    at("2027-03-14T11:55:20Z");
    await f.t.withIdentity({ subject: "max" }).mutation(api.instances.undoResolve, {
      instanceId: id,
    });
    expect((await get()).state).toBe("upcoming");
    await tick(f.t, "2027-03-14T12:00:00Z");
    expect((await get()).state).toBe("due");
    const afterFirst = (await get()).firedSteps.map((s) => s.stepId);
    await tick(f.t, "2027-03-14T12:00:00Z");
    await tick(f.t, "2027-03-14T12:10:00Z");
    const afterSecond = (await get()).firedSteps.map((s) => s.stepId);
    expect(new Set(afterSecond).size).toBe(afterSecond.length);
    expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
    await tick(f.t, "2027-03-14T13:30:00Z");
    const final = await get();
    expect(final.state).toBe("missed");
    const ids = final.firedSteps.map((s) => s.stepId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("another caregiver cannot undo and an open instance cannot be undone", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const id = await resolveAt(f, "2027-03-14T11:00:00Z");
    await expect(
      f.t.withIdentity({ subject: "pat" }).mutation(api.instances.undoResolve, { instanceId: id }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    const asMax = f.t.withIdentity({ subject: "max" });
    await asMax.mutation(api.instances.undoResolve, { instanceId: id });
    await expect(
      asMax.mutation(api.instances.undoResolve, { instanceId: id }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("a device confirmation cannot be undone", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: instance!._id, via: "button" });
    await expect(
      f.t
        .withIdentity({ subject: "max" })
        .mutation(api.instances.undoResolve, { instanceId: instance!._id }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("access: viewers, devices and outsiders are forbidden", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const id = await resolveAt(f, "2027-03-14T11:00:00Z");
    for (const subject of ["val", "phone", "display", "nobody"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.instances.undoResolve, { instanceId: id }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });

  test("the scheduler picks a restored instance up: upcoming opens, then misses", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const id = await resolveAt(f, "2027-03-14T11:00:00Z");
    await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.undoResolve, { instanceId: id });
    await tick(f.t, "2027-03-14T12:00:00Z");
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))?.state).toBe("due");
    await tick(f.t, "2027-03-14T13:30:00Z");
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))?.state).toBe("missed");
  });

  test("a restored due instance still closes as missed when its window ends", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await tick(f.t, "2027-03-14T12:00:00Z");
    const id = await resolveAt(f, "2027-03-14T12:05:00Z");
    await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.undoResolve, { instanceId: id });
    await tick(f.t, "2027-03-14T13:30:00Z");
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))?.state).toBe("missed");
  });
});

describe("snoozeTaskInstance", () => {
  test("snoozes an open instance for the requested minutes, 15 by default", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    const snoozed = await f.t.run(
      async (ctx) =>
        await snoozeInstance(
          ctx,
          AGENT,
          { instanceId: instance!._id, minutes: 20 },
          Date.parse("2027-03-14T12:05:00Z"),
        ),
    );
    expect(snoozed.snoozedUntil).toBe(Date.parse("2027-03-14T12:25:00Z"));
    const defaulted = await f.t.run(
      async (ctx) =>
        await snoozeInstance(
          ctx,
          AGENT,
          { instanceId: instance!._id },
          Date.parse("2027-03-14T12:10:00Z"),
        ),
    );
    expect(defaulted.snoozedUntil).toBe(Date.parse("2027-03-14T12:25:00Z"));
  });

  test("rejects minutes outside 1..120 and leaves instances that are not open unchanged", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    for (const minutes of [0, 121, 1.5]) {
      await expect(
        asPhone.mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id, minutes }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
    const upcoming = await asPhone.mutation(api.instances.snoozeTaskInstance, {
      instanceId: instance!._id,
      minutes: 120,
    });
    expect(upcoming.snoozedUntil).toBeUndefined();
  });

  test("access: only the household's devices may snooze", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    for (const subject of ["nobody", "pat", "max", "val"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
    await expect(
      f.t
        .withIdentity({ subject: "display" })
        .mutation(api.instances.snoozeTaskInstance, { instanceId: instance!._id }),
    ).resolves.toBeDefined();
  });
});

describe("claimTaskInstance", () => {
  test("first claim wins and an instance that is not open is not claimable", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    const asMax = f.t.withIdentity({ subject: "max" });
    const early = await asMax.mutation(api.instances.claimTaskInstance, {
      instanceId: instance!._id,
    });
    expect(early.claimedBy).toBeUndefined();

    await tick(f.t, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:05:00Z");
    const first = await asMax.mutation(api.instances.claimTaskInstance, {
      instanceId: instance!._id,
    });
    expect(first.claimedBy).toBe("max");
    const second = await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id });
    expect(second.claimedBy).toBe("max");
  });

  test("a missed instance can still be claimed", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T13:00:00Z");
    at("2027-03-14T13:05:00Z");
    const claimed = await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id });
    expect(claimed).toMatchObject({ state: "missed", claimedBy: "pat" });
  });

  test("access: only editor caregivers of the household may claim", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    for (const subject of ["nobody", "val", "phone", "display"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("today", () => {
  test("lists the day's instances in schedule order for caregivers and devices", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    await makeTask(f, "Lunch pills", ["12:00"]);
    await makeTask(f, "Morning pills", ["08:00"]);
    for (const subject of ["pat", "val", "phone"]) {
      const entries = await f.t
        .withIdentity({ subject })
        .query(api.instances.today, { householdId: f.householdId });
      expect(
        entries.map((e) => [e.displayLabel, e.scheduledTime, e.state]),
        subject,
      ).toEqual([
        ["Morning pills", "08:00", "upcoming"],
        ["Lunch pills", "12:00", "upcoming"],
      ]);
    }
  });

  test("absent optional values are null, not missing keys", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    await makeTask(f, "Lunch pills", ["12:00"]);
    const [entry] = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entry).toMatchObject({
      pillDescription: null,
      confirmedAt: null,
      confirmedLocalTime: null,
      confirmedVia: null,
      claimedBy: null,
      claimedByName: null,
      confirmedBy: null,
      confirmedByName: null,
      resolutionNote: null,
      carriedOver: false,
      reopenable: false,
    });
  });

  test("entries carry their own local date", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    await makeTask(f, "Lunch pills", ["12:00"]);
    const [entry] = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entry).toMatchObject({ localDate: "2027-03-20" });
  });

  test("a caregiver's resolution names them and keeps the note; a device's does not", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await makeTask(f, "Evening pills", ["08:30"]);
    const [first, second] = await instancesOn(f, "2027-03-14");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.instances.confirmTaskInstance, {
      instanceId: first!._id,
      via: "phone_app",
      note: "Called her",
    });
    await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: second!._id, via: "button" });
    const entries = await f.t
      .withIdentity({ subject: "val" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entries.find((e) => e.instanceId === first!._id)).toMatchObject({
      state: "resolved",
      confirmedVia: "caregiver",
      confirmedLocalTime: "07:30",
      confirmedBy: "pat",
      confirmedByName: "Pat",
      resolutionNote: "Called her",
    });
    expect(entries.find((e) => e.instanceId === second!._id)).toMatchObject({
      state: "confirmed",
      confirmedVia: "button",
      confirmedLocalTime: "07:30",
      confirmedBy: "phone",
      confirmedByName: null,
      resolutionNote: null,
    });
  });

  test("confirmedByName is null when the confirming caregiver is no longer a member", async () => {
    const f = await setup("2027-03-14T11:30:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: instance!._id, via: "phone_app" });
    await f.t.run(async (ctx) => {
      const member = await ctx.db
        .query("householdMembers")
        .withIndex("by_household_user", (q) =>
          q.eq("householdId", f.householdId).eq("userId", "max"),
        )
        .unique();
      await ctx.db.delete(member!._id);
    });
    const [entry] = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entry).toMatchObject({ confirmedBy: "max", confirmedByName: null });
  });

  test("yesterday's open instance is listed first with yesterday's local date", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Late pills", ["23:30"]);
    await makeTask(f, "Morning pills", ["08:00"]);
    await tick(f.t, "2027-03-15T03:35:00Z");
    at("2027-03-15T04:10:00Z");
    const entries = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entries[0]).toMatchObject({
      displayLabel: "Late pills",
      localDate: "2027-03-14",
      carriedOver: true,
    });
    expect(entries.slice(1).every((e) => e.localDate === "2027-03-15" && !e.carriedOver)).toBe(
      true,
    );
  });

  test("a claimed entry names who is on it, for every caregiver and device", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:05:00Z");
    await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id });
    for (const subject of ["max", "val", "phone"]) {
      const [entry] = await f.t
        .withIdentity({ subject })
        .query(api.instances.today, { householdId: f.householdId });
      expect(entry, subject).toMatchObject({ claimedBy: "pat", claimedByName: "Pat" });
    }
  });

  test("claimedByName is null when the claimer is no longer a member", async () => {
    const f = await setup("2027-03-14T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    const [instance] = await instancesOn(f, "2027-03-14");
    await tick(f.t, "2027-03-14T12:00:00Z");
    at("2027-03-14T12:05:00Z");
    await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.instances.claimTaskInstance, { instanceId: instance!._id });
    await f.t.run(async (ctx) => {
      const member = await ctx.db
        .query("householdMembers")
        .withIndex("by_household_user", (q) =>
          q.eq("householdId", f.householdId).eq("userId", "max"),
        )
        .unique();
      await ctx.db.delete(member!._id);
    });
    const [entry] = await f.t
      .withIdentity({ subject: "pat" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entry).toMatchObject({ claimedBy: "max", claimedByName: null });
  });

  test("access: outsiders and other households' devices cannot read the day", async () => {
    const f = await setup("2027-03-20T11:00:00Z");
    await expect(
      f.t
        .withIdentity({ subject: "nobody" })
        .query(api.instances.today, { householdId: f.householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("confirmDueTask", () => {
  async function dayFixture(): Promise<Fixture> {
    const f = await setup("2027-03-20T11:00:00Z");
    await makeTask(f, "Morning pills", ["08:00"]);
    await makeTask(f, "Lunch pills", ["12:00"]);
    await makeTask(f, "Evening pills", ["21:00"]);
    await tick(f.t, "2027-03-20T11:00:00Z");
    await tick(f.t, "2027-03-20T12:00:00Z");
    return f;
  }

  async function done(f: Fixture, iso: string, label?: string, via: "button" | "voice" = "button") {
    return await f.t.run(
      async (ctx) =>
        await confirmDueTaskCore(
          ctx,
          AGENT,
          { householdId: f.householdId, via, label },
          Date.parse(iso),
        ),
    );
  }

  test("the day lists three instances and Done with no label confirms the one that is due", async () => {
    const f = await dayFixture();
    const entries = await f.t
      .withIdentity({ subject: "phone" })
      .query(api.instances.today, { householdId: f.householdId });
    expect(entries).toHaveLength(3);
    const result = await done(f, "2027-03-20T12:05:00Z");
    expect(result).toMatchObject({
      status: "confirmed",
      displayLabel: "Morning pills",
      state: "confirmed",
      confirmedAt: Date.parse("2027-03-20T12:05:00Z"),
    });
  });

  test("a second Done with nothing due changes nothing", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    expect((await done(f, "2027-03-20T12:06:00Z")).status).toBe("nothing_due");
  });

  test("asking again by label reports the original confirmation time (double-dose guard)", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    const again = await done(f, "2027-03-20T12:30:00Z", "MORNING", "voice");
    expect(again).toMatchObject({
      status: "already_done",
      confirmedAt: Date.parse("2027-03-20T12:05:00Z"),
    });
  });

  test("a task hours away is not due yet and stays unconfirmed", async () => {
    const f = await dayFixture();
    const result = await done(f, "2027-03-20T12:30:00Z", "lunch", "voice");
    expect(result).toMatchObject({ status: "not_due_yet", displayLabel: "Lunch pills" });
    const lunch = (await instancesOn(f, "2027-03-20")).find((i) => i.scheduledTime === "12:00");
    expect(lunch?.state).toBe("upcoming");
  });

  test("several open matches ask which one, and unknown labels are not found", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    const ambiguous = await done(f, "2027-03-20T15:30:00Z", "pills", "voice");
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.options?.map((o) => o.displayLabel)).toEqual(["Lunch pills", "Evening pills"]);
    expect((await done(f, "2027-03-20T15:30:00Z", "insulin", "voice")).status).toBe("not_found");
  });

  test("a label prefers the dose that is due now over a later one", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z");
    await tick(f.t, "2027-03-20T16:00:00Z");
    const result = await done(f, "2027-03-20T16:05:00Z", "pills", "voice");
    expect(result).toMatchObject({ status: "confirmed", displayLabel: "Lunch pills" });
  });

  test("both paired devices get the defaulted spoken prompt", async () => {
    const f = await dayFixture();
    await tick(f.t, "2027-03-20T16:00:00Z");
    const lunch = (await instancesOn(f, "2027-03-20")).find((i) => i.scheduledTime === "12:00")!;
    const rows = await f.t.run(
      async (ctx) =>
        await ctx.db
          .query("notificationOutbox")
          .withIndex("by_task_instance", (q) => q.eq("taskInstanceId", lunch._id))
          .collect(),
    );
    expect(rows.map((r) => r.body)).toEqual(["Time for Lunch pills.", "Time for Lunch pills."]);
    expect(rows.map((r) => r.recipientDeviceId).sort()).toEqual([f.phone, f.display].sort());
  });

  test("a device presses Done through the public function", async () => {
    const f = await dayFixture();
    at("2027-03-20T12:05:00Z");
    const result = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "widget" });
    expect(result).toMatchObject({ status: "confirmed", displayLabel: "Morning pills" });
  });

  test("a device's Done through the public function records transport app", async () => {
    const f = await dayFixture();
    at("2027-03-20T12:05:00Z");
    await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "button" });
    const morning = (await instancesOn(f, "2027-03-20")).find((i) => i.scheduledTime === "08:00")!;
    expect(await confirmDetail(f, morning._id)).toMatchObject({
      to: "confirmed",
      transport: "app",
    });
  });

  test("the voice agent's Done records no transport key at all", async () => {
    const f = await dayFixture();
    await done(f, "2027-03-20T12:05:00Z", undefined, "voice");
    const morning = (await instancesOn(f, "2027-03-20")).find((i) => i.scheduledTime === "08:00")!;
    const detail = await confirmDetail(f, morning._id);
    expect(detail).toMatchObject({ to: "confirmed", via: "voice" });
    expect(detail).not.toHaveProperty("transport");
  });

  test("access: only the household's devices may press Done", async () => {
    const f = await dayFixture();
    for (const subject of ["nobody", "pat", "max", "val"]) {
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.confirmDueTask, { householdId: f.householdId, via: "button" }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("senior reminders", () => {
  async function reminderFixture(): Promise<Fixture> {
    return await setup("2027-03-20T12:00:00Z");
  }

  test("the device creates a one-off reminder that is not high priority", async () => {
    const f = await reminderFixture();
    const task = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.createSeniorReminder, {
        householdId: f.householdId,
        title: "call the plumber",
        time: "10:00",
        onDate: "2027-03-22",
      });
    expect(task).toMatchObject({
      type: "reminder",
      displayLabel: "Call the plumber",
      spokenPrompt: "Reminder: call the plumber.",
      createdByKind: "senior",
      createdBy: "phone",
      onceOn: "2027-03-22",
      windowMinutes: 30,
      highPriority: false,
      active: true,
    });
    expect(task.daysOfWeek).toBeUndefined();
  });

  test("recurring reminders keep their weekdays; all seven days means every day", async () => {
    const f = await reminderFixture();
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const base = { householdId: f.householdId, time: "09:00" };
    const some = await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "water the plants",
      days: [4, 1],
    });
    expect(some.daysOfWeek).toEqual([1, 4]);
    const every = await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "take a walk",
      days: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(every.daysOfWeek).toBeUndefined();
    const dated = await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "dentist",
      onDate: "2027-03-25",
      days: [1],
    });
    expect(dated.daysOfWeek).toBeUndefined();
  });

  test("rejects blank titles, bad times, bad dates and dates that have passed", async () => {
    const f = await reminderFixture();
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const base = { householdId: f.householdId, title: "x", time: "10:00" };
    for (const bad of [
      { title: "  " },
      { time: "25:00" },
      { onDate: "2027-13-01" },
      { onDate: "2020-01-01" },
      { days: [0] },
    ]) {
      await expect(
        asPhone.mutation(api.instances.createSeniorReminder, { ...base, ...bad }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
    await expect(
      asPhone.mutation(api.instances.createSeniorReminder, { ...base, onDate: "2020-01-01" }),
    ).rejects.toMatchObject({ data: { message: "That date has already passed" } });
    await expect(
      asPhone.mutation(api.instances.createSeniorReminder, { ...base, title: "x".repeat(201) }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      asPhone.mutation(api.instances.createSeniorReminder, { ...base, title: "x".repeat(200) }),
    ).resolves.toBeDefined();
  });

  test("a long spoken reminder keeps its title and gets a label a caregiver can save", async () => {
    const f = await reminderFixture();
    const title = "call the pharmacy about refilling my blood pressure pills before saturday";
    expect(title).toHaveLength(73);
    const task = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.createSeniorReminder, {
        householdId: f.householdId,
        title,
        time: "10:00",
      });
    expect(task).toMatchObject({
      title,
      displayLabel: "Call the pharmacy about refilling my blood pressure pills…",
      spokenPrompt: `Reminder: ${title}.`,
    });
    const pat = f.t.withIdentity({ subject: "pat" });
    await pat.mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: task._id,
      times: ["11:30"],
      highPriority: true,
    });
    const stopped = await f.t.run(
      async (ctx) =>
        await executeAgentTool(
          ctx,
          {
            householdId: f.householdId,
            actor: { kind: "agent", onBehalfOf: "pat" },
            now: Date.now(),
          },
          { name: "stop_task", input: { task_id: task._id } },
        ),
    );
    expect(stopped.isError).toBe(false);
    const saved = await f.t.run(async (ctx) => await ctx.db.get(task._id));
    expect(saved).toMatchObject({ times: ["11:30"], highPriority: true, active: false, title });
  });

  test("a reminder saved earlier with a label over the cap can still be changed", async () => {
    const f = await reminderFixture();
    const label = "Call the pharmacy about refilling my blood pressure pills before saturday";
    const task = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.createSeniorReminder, {
        householdId: f.householdId,
        title: label.toLowerCase(),
        time: "10:00",
      });
    await f.t.run(async (ctx) => await ctx.db.patch(task._id, { displayLabel: label }));
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: task._id,
      times: ["11:00"],
    });
    const saved = await f.t.run(async (ctx) => await ctx.db.get(task._id));
    expect(saved).toMatchObject({
      times: ["11:00"],
      displayLabel: "Call the pharmacy about refilling my blood pressure pills…",
    });
  });

  test("a today reminder is allowed", async () => {
    const f = await reminderFixture();
    const task = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.createSeniorReminder, {
        householdId: f.householdId,
        title: "stretch",
        time: "13:00",
        onDate: "2027-03-20",
      });
    expect(task.onceOn).toBe("2027-03-20");
  });

  test("cancel: vague queries are ambiguous, clear ones cancel, caregiver tasks and blanks match nothing", async () => {
    const f = await reminderFixture();
    await makeTask(f, "Morning pills", ["08:00"]);
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const base = { householdId: f.householdId, time: "10:00" };
    await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "call the plumber",
      onDate: "2027-03-22",
    });
    await asPhone.mutation(api.instances.createSeniorReminder, {
      ...base,
      title: "water the plants",
      days: [1, 4],
    });
    const cancel = async (query: string) =>
      await asPhone.mutation(api.instances.cancelSeniorReminder, {
        householdId: f.householdId,
        query,
      });
    expect(await cancel("the p")).toEqual({
      status: "ambiguous",
      titles: ["call the plumber", "water the plants"],
    });
    expect(await cancel("Plumber")).toEqual({ status: "cancelled", titles: ["call the plumber"] });
    expect((await cancel("Morning")).status).toBe("not_found");
    expect((await cancel("  ")).status).toBe("not_found");
    expect((await cancel("plumber")).status).toBe("not_found");
  });

  test("cancelling removes the reminder's open instances so nothing keeps prompting", async () => {
    const f = await setup("2027-03-21T13:00:00Z");
    const asPhone = f.t.withIdentity({ subject: "phone" });
    await asPhone.mutation(api.instances.createSeniorReminder, {
      householdId: f.householdId,
      title: "stretch",
      time: "10:00",
    });
    await tick(f.t, "2027-03-21T14:00:00Z");
    expect((await instancesOn(f, "2027-03-21")).map((i) => i.state)).toEqual(["due"]);
    at("2027-03-21T14:05:00Z");
    const result = await asPhone.mutation(api.instances.cancelSeniorReminder, {
      householdId: f.householdId,
      query: "stretch",
    });
    expect(result.status).toBe("cancelled");
    expect(await instancesOn(f, "2027-03-21")).toHaveLength(0);
    expect(await instancesOn(f, "2027-03-22")).toHaveLength(0);
  });

  test("access: only the household's devices may create or cancel reminders", async () => {
    const f = await reminderFixture();
    for (const subject of ["nobody", "pat", "val"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.instances.createSeniorReminder, {
          householdId: f.householdId,
          title: "x",
          time: "10:00",
        }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
      await expect(
        f.t
          .withIdentity({ subject })
          .mutation(api.instances.cancelSeniorReminder, { householdId: f.householdId, query: "x" }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});

describe("logDose", () => {
  async function doseFixture() {
    const f = await setup("2027-03-20T12:00:00Z");
    const taskId = await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
      householdId: f.householdId,
      type: "medication",
      title: "Ibuprofen",
      displayLabel: "Ibuprofen",
      asNeededMaxPerDay: 3,
    });
    return { f, taskId };
  }

  test("editors and devices log doses reported under their own id", async () => {
    const { f, taskId } = await doseFixture();
    for (const [subject, via] of [
      ["pat", "phone_app"],
      ["phone", "button"],
    ] as const) {
      const id = await f.t.withIdentity({ subject }).mutation(api.instances.logDose, {
        householdId: f.householdId,
        taskId,
        takenAt: Date.now() - 1000,
        via,
        note: "with food",
      });
      const row = await f.t.run(async (ctx) => await ctx.db.get(id));
      expect(row).toMatchObject({ reportedBy: subject, reportedVia: via, note: "with food" });
    }
  });

  test("a dose more than five minutes ahead is rejected, within five is accepted", async () => {
    const { f, taskId } = await doseFixture();
    const asPat = f.t.withIdentity({ subject: "pat" });
    const base = { householdId: f.householdId, taskId, via: "phone_app" as const };
    await expect(
      asPat.mutation(api.instances.logDose, { ...base, takenAt: Date.now() + 6 * 60_000 }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      asPat.mutation(api.instances.logDose, { ...base, takenAt: Date.now() + 4 * 60_000 }),
    ).resolves.toBeDefined();
  });

  test("a non-finite dose time is rejected as invalid", async () => {
    const { f, taskId } = await doseFixture();
    const asPat = f.t.withIdentity({ subject: "pat" });
    const base = { householdId: f.householdId, taskId, via: "phone_app" as const };
    for (const takenAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        asPat.mutation(api.instances.logDose, { ...base, takenAt }),
        String(takenAt),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
    expect(await f.t.run(async (ctx) => (await ctx.db.query("doseLog").collect()).length)).toBe(0);
  });

  test("the core helper allows the agent with no reporter and checks the clock it is given", async () => {
    const { f, taskId } = await doseFixture();
    const now = Date.parse("2027-03-20T12:00:00Z");
    const args = { householdId: f.householdId, taskId, via: "voice" as const };
    const id = await f.t.run(
      async (ctx) => await logDoseCore(ctx, AGENT, { ...args, takenAt: now + 5 * 60_000 }, now),
    );
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))?.reportedBy).toBeUndefined();
    await expect(
      f.t.run(
        async (ctx) =>
          await logDoseCore(ctx, AGENT, { ...args, takenAt: now + 5 * 60_000 + 1 }, now),
      ),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("a task from another household is not found", async () => {
    const { f, taskId } = await doseFixture();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await expect(
      xen.mutation(api.instances.logDose, {
        householdId: other,
        taskId,
        takenAt: Date.now(),
        via: "phone_app",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("access: viewers, outsiders and other households' devices are forbidden", async () => {
    const { f, taskId } = await doseFixture();
    const xen = f.t.withIdentity({ subject: "xen" });
    const other = await xen.mutation(api.households.create, {
      seniorPreferredName: "Dad",
      timezone: "America/Chicago",
      caregiverDisplayName: "Xen",
    });
    await pair(f.t, other, xen, "xdev", "senior_phone");
    for (const subject of ["nobody", "val", "xen", "xdev"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.instances.logDose, {
          householdId: f.householdId,
          taskId,
          takenAt: Date.now(),
          via: "phone_app",
        }),
        subject,
      ).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });
});
