// households.test.ts
// Purpose: Tests for households.ts with convex-test: creation and defaults, access control
// for every public function (non-members, viewers, devices), role rules for join codes,
// single-use and 24 hour expiry of codes, caregiver and device redemption, member removal
// and the on-call rule, push token ownership, the device identity claim, and the last-primary guard. These stand in for the pgTAP grant and
// RLS checks of the Supabase test suite.
//
// Last modified: 2026-10-28

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal, api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** A valid household timezone used across tests. */
const NY = "America/New_York";

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  return convexTest(schema, modules);
}

/** The convex-test harness type, with the schema's table types. */
type TestConvex = ReturnType<typeof makeBackend>;

/**
 * purpose: Create a household owned by user_a.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<Id<"households">>) The household.
 */
async function createHousehold(t: TestConvex): Promise<Id<"households">> {
  return await t.withIdentity({ subject: "user_a" }).mutation(api.households.create, {
    seniorPreferredName: "Margaret",
    timezone: NY,
    caregiverDisplayName: "Anna",
  });
}

/**
 * purpose: Add a caregiver with a role through the real invite flow.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) New caregiver's user id.
 * @param grants: (string) Caregiver grant.
 * @return: (Promise<void>) Resolves once joined.
 */
async function addCaregiver(
  t: TestConvex,
  householdId: Id<"households">,
  userId: string,
  grants: "caregiver_primary" | "caregiver_member" | "caregiver_viewer",
): Promise<void> {
  const { code } = await t
    .withIdentity({ subject: "user_a" })
    .mutation(api.households.createJoinCode, { householdId, grants });
  await t.withIdentity({ subject: userId }).mutation(api.households.redeemJoinCode, { code });
}

/**
 * purpose: Pair a device through the internal mutation.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Device's Clerk user id.
 * @return: (Promise<Id<"devices">>) The device.
 */
async function pairDevice(
  t: TestConvex,
  householdId: Id<"households">,
  userId: string,
): Promise<Id<"devices">> {
  const { code } = await t
    .withIdentity({ subject: "user_a" })
    .mutation(api.households.createJoinCode, { householdId, grants: "home_display" });
  const result = await t.mutation(internal.households.pairDevice, { code, userId });
  return result.deviceId;
}

/**
 * purpose: Create a join code as user_a.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param grants: (string) Grant for the code.
 * @return: (Promise<string>) The code.
 */
async function makeCode(
  t: TestConvex,
  householdId: Id<"households">,
  grants:
    "senior_phone" | "home_display" | "caregiver_primary" | "caregiver_member" | "caregiver_viewer",
): Promise<string> {
  const { code } = await t
    .withIdentity({ subject: "user_a" })
    .mutation(api.households.createJoinCode, { householdId, grants });
  return code;
}

describe("create", () => {
  test("seeds defaults, the primary member and the on-call contact", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const asA = t.withIdentity({ subject: "user_a" });

    const household = await asA.query(api.households.get, { householdId });
    expect(household).toMatchObject({
      seniorPreferredName: "Margaret",
      timezone: NY,
      onCallUserId: "user_a",
      digestTime: "19:00",
      eventNoticeTime: "08:00",
      shareTranscripts: false,
      backgroundPaused: false,
    });
    const members = await asA.query(api.households.listMembers, { householdId });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: "user_a", role: "primary", displayName: "Anna" });
  });

  test("seeds the Medication and Prompt only policies with the SPEC steps", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const policies = await t.run(
      async (ctx) =>
        await ctx.db
          .query("escalationPolicies")
          .withIndex("by_household", (q) => q.eq("householdId", householdId))
          .collect(),
    );
    expect(policies).toHaveLength(2);
    const medication = policies.find((p) => p.systemKey === "medication");
    const promptOnly = policies.find((p) => p.systemKey === "prompt_only");
    expect(medication?.name).toBe("Medication");
    expect(medication?.steps).toEqual([
      { id: expect.any(String), offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
      { id: expect.any(String), offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
      { id: expect.any(String), offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
      {
        id: expect.any(String),
        offsetMinutes: 45,
        action: "alert_all_caregivers",
        skipIfClaimed: true,
      },
    ]);
    expect(new Set(medication?.steps.map((s) => s.id)).size).toBe(4);
    expect(promptOnly?.name).toBe("Prompt only");
    expect(promptOnly?.steps).toEqual([
      { id: expect.any(String), offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
    ]);
  });

  test("a paired device cannot create a household", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await pairDevice(t, householdId, "device_1");
    await expect(
      t.withIdentity({ subject: "device_1" }).mutation(api.households.create, {
        seniorPreferredName: "Bob",
        timezone: NY,
        caregiverDisplayName: "Dev",
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("an identity with the device claim but no devices row cannot create", async () => {
    const t = makeBackend();
    await expect(
      t
        .withIdentity({ subject: "device_x", sunny_kind: "device" })
        .mutation(api.households.create, {
          seniorPreferredName: "Bob",
          timezone: NY,
          caregiverDisplayName: "Dev",
        }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("a removed device (claim set, row deleted) cannot create or redeem a code", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const deviceId = await pairDevice(t, householdId, "device_1");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.removeDevice, { householdId, deviceId });
    const code = await makeCode(t, householdId, "caregiver_member");
    const asRemoved = t.withIdentity({ subject: "device_1", sunny_kind: "device" });
    await expect(
      asRemoved.mutation(api.households.create, {
        seniorPreferredName: "Bob",
        timezone: NY,
        caregiverDisplayName: "Dev",
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(asRemoved.mutation(api.households.redeemJoinCode, { code })).rejects.toMatchObject(
      { data: { code: "forbidden" } },
    );
  });

  test("stores the canonical timezone spelling", async () => {
    const t = makeBackend();
    const householdId = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.create, {
        seniorPreferredName: "Bob",
        timezone: "america/new_york",
        caregiverDisplayName: "Dev",
      });
    const asA = t.withIdentity({ subject: "user_a" });
    expect((await asA.query(api.households.get, { householdId })).timezone).toBe(NY);
    await asA.mutation(api.households.update, { householdId, timezone: "pacific/auckland" });
    expect((await asA.query(api.households.get, { householdId })).timezone).toBe(
      "Pacific/Auckland",
    );
  });

  test("requires sign in", async () => {
    const t = makeBackend();
    await expect(
      t.mutation(api.households.create, {
        seniorPreferredName: "Bob",
        timezone: NY,
        caregiverDisplayName: "Dev",
      }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });

  test.each([
    ["blank senior name", { seniorPreferredName: "  ", timezone: NY, caregiverDisplayName: "A" }],
    ["blank caregiver name", { seniorPreferredName: "B", timezone: NY, caregiverDisplayName: " " }],
    [
      "abbreviated timezone",
      { seniorPreferredName: "B", timezone: "EST", caregiverDisplayName: "A" },
    ],
    [
      "unknown timezone",
      { seniorPreferredName: "B", timezone: "Not/AZone", caregiverDisplayName: "A" },
    ],
  ])("rejects %s", async (_label, args) => {
    const t = makeBackend();
    await expect(
      t.withIdentity({ subject: "user_a" }).mutation(api.households.create, args),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });
});

describe("mine", () => {
  test("lists caregiver households with role and device households with kind", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await pairDevice(t, householdId, "device_1");

    const asCaregiver = await t.withIdentity({ subject: "user_a" }).query(api.households.mine, {});
    expect(asCaregiver).toHaveLength(1);
    expect(asCaregiver[0]).toMatchObject({ role: "primary", deviceKind: null });

    const asDevice = await t.withIdentity({ subject: "device_1" }).query(api.households.mine, {});
    expect(asDevice).toHaveLength(1);
    expect(asDevice[0]).toMatchObject({ role: null, deviceKind: "home_display" });
  });

  test("is empty for a stranger and when signed out", async () => {
    const t = makeBackend();
    await createHousehold(t);
    expect(await t.withIdentity({ subject: "user_x" }).query(api.households.mine, {})).toEqual([]);
    expect(await t.query(api.households.mine, {})).toEqual([]);
  });
});

describe("access control", () => {
  test("every household function rejects a non-member", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const deviceId = await pairDevice(t, householdId, "device_1");
    const code = await makeCode(t, householdId, "caregiver_member");
    const stranger = t.withIdentity({ subject: "user_x" });

    const attempts: Record<string, () => Promise<unknown>> = {
      get: () => stranger.query(api.households.get, { householdId }),
      update: () => stranger.mutation(api.households.update, { householdId, digestTime: "20:00" }),
      listMembers: () => stranger.query(api.households.listMembers, { householdId }),
      updateMemberRole: () =>
        stranger.mutation(api.households.updateMemberRole, {
          householdId,
          userId: "user_a",
          role: "viewer",
        }),
      removeMember: () =>
        stranger.mutation(api.households.removeMember, {
          householdId,
          userId: "user_a",
        }),
      createJoinCode: () =>
        stranger.mutation(api.households.createJoinCode, {
          householdId,
          grants: "caregiver_viewer",
        }),
      listJoinCodes: () => stranger.query(api.households.listJoinCodes, { householdId }),
      deleteJoinCode: () => stranger.mutation(api.households.deleteJoinCode, { householdId, code }),
      listDevices: () => stranger.query(api.households.listDevices, { householdId }),
      removeDevice: () => stranger.mutation(api.households.removeDevice, { householdId, deviceId }),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      await expect(attempt(), name).rejects.toMatchObject({ data: { code: "forbidden" } });
    }
  });

  test("every household function rejects a signed-out caller", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await expect(t.query(api.households.get, { householdId })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    await expect(
      t.mutation(api.households.update, { householdId, digestTime: "20:00" }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    await expect(t.query(api.households.listDevices, { householdId })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });

  test("a device of another household is not a reader", async () => {
    const t = makeBackend();
    const first = await createHousehold(t);
    const second = await t.withIdentity({ subject: "user_b" }).mutation(api.households.create, {
      seniorPreferredName: "Joe",
      timezone: NY,
      caregiverDisplayName: "Bea",
    });
    await pairDevice(t, first, "device_1");
    await expect(
      t.withIdentity({ subject: "device_1" }).query(api.households.get, { householdId: second }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("a paired device can read but not edit", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await pairDevice(t, householdId, "device_1");
    const asDevice = t.withIdentity({ subject: "device_1" });
    const household = await asDevice.query(api.households.get, { householdId });
    expect(household.seniorPreferredName).toBe("Margaret");
    expect(await asDevice.query(api.households.listDevices, { householdId })).toHaveLength(1);
    await expect(
      asDevice.mutation(api.households.update, { householdId, digestTime: "20:00" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      asDevice.query(api.households.listJoinCodes, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("viewers can read but not edit", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_v", "caregiver_viewer");
    const asViewer = t.withIdentity({ subject: "user_v" });

    expect(await asViewer.query(api.households.get, { householdId })).toBeTruthy();
    expect(await asViewer.query(api.households.listMembers, { householdId })).toHaveLength(2);
    expect(await asViewer.query(api.households.listDevices, { householdId })).toEqual([]);
    await expect(
      asViewer.mutation(api.households.update, { householdId, shareTranscripts: true }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      asViewer.mutation(api.households.createJoinCode, { householdId, grants: "home_display" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      asViewer.query(api.households.listJoinCodes, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("members edit but cannot manage other members", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_m", "caregiver_member");
    const asMember = t.withIdentity({ subject: "user_m" });

    await asMember.mutation(api.households.update, { householdId, shareTranscripts: true });
    await expect(
      asMember.mutation(api.households.updateMemberRole, {
        householdId,
        userId: "user_a",
        role: "viewer",
      }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      asMember.mutation(api.households.removeMember, { householdId, userId: "user_a" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });
});

describe("update", () => {
  test("changes only the fields provided", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.update, {
      householdId,
      seniorFullName: "Margaret Ellis",
      timezone: "America/Chicago",
      digestTime: "20:30",
      eventNoticeTime: "07:15",
      shareTranscripts: true,
      backgroundPaused: true,
    });
    expect(await asA.query(api.households.get, { householdId })).toMatchObject({
      seniorPreferredName: "Margaret",
      seniorFullName: "Margaret Ellis",
      timezone: "America/Chicago",
      digestTime: "20:30",
      eventNoticeTime: "07:15",
      shareTranscripts: true,
      backgroundPaused: true,
      onCallUserId: "user_a",
    });
  });

  test.each([
    ["timezone", { timezone: "EST" }],
    ["digest time", { digestTime: "7pm" }],
    ["event notice time", { eventNoticeTime: "25:00" }],
    ["blank name", { seniorPreferredName: " " }],
  ])("rejects an invalid %s", async (_label, fields) => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await expect(
      t.withIdentity({ subject: "user_a" }).mutation(api.households.update, {
        householdId,
        ...fields,
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("onCallUserId must be a member of the household", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const asA = t.withIdentity({ subject: "user_a" });
    await expect(
      asA.mutation(api.households.update, { householdId, onCallUserId: "user_x" }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });

    await addCaregiver(t, householdId, "user_m", "caregiver_member");
    await asA.mutation(api.households.update, { householdId, onCallUserId: "user_m" });
    expect((await asA.query(api.households.get, { householdId })).onCallUserId).toBe("user_m");
  });
});

describe("members", () => {
  test("a primary can change a role; an unknown member is not found", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_m", "caregiver_member");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.updateMemberRole, {
      householdId,
      userId: "user_m",
      role: "viewer",
    });
    const members = await asA.query(api.households.listMembers, { householdId });
    expect(members.find((m) => m.userId === "user_m")?.role).toBe("viewer");
    await expect(
      asA.mutation(api.households.updateMemberRole, {
        householdId,
        userId: "user_zzz",
        role: "viewer",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("the last primary cannot be demoted or removed", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const asA = t.withIdentity({ subject: "user_a" });
    await expect(
      asA.mutation(api.households.updateMemberRole, {
        householdId,
        userId: "user_a",
        role: "member",
      }),
    ).rejects.toMatchObject({
      data: { code: "invalid", message: "A household needs at least one primary caregiver" },
    });
    await expect(
      asA.mutation(api.households.removeMember, { householdId, userId: "user_a" }),
    ).rejects.toMatchObject({
      data: { code: "invalid", message: "A household needs at least one primary caregiver" },
    });
    expect(await asA.query(api.households.listMembers, { householdId })).toHaveLength(1);
  });

  test("a primary can demote or remove themselves when another primary exists", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_p2", "caregiver_primary");
    await addCaregiver(t, householdId, "user_p3", "caregiver_primary");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.updateMemberRole, {
      householdId,
      userId: "user_a",
      role: "viewer",
    });
    const asP2 = t.withIdentity({ subject: "user_p2" });
    await asP2.mutation(api.households.removeMember, { householdId, userId: "user_p2" });
    const members = await t
      .withIdentity({ subject: "user_p3" })
      .query(api.households.listMembers, { householdId });
    expect(members.map((m) => m.userId).sort()).toEqual(["user_a", "user_p3"]);
  });

  test("removing the on-call member clears onCallUserId", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_m", "caregiver_member");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.update, { householdId, onCallUserId: "user_m" });

    await asA.mutation(api.households.removeMember, { householdId, userId: "user_m" });

    const household = await asA.query(api.households.get, { householdId });
    expect(household.onCallUserId).toBeUndefined();
    expect(await asA.query(api.households.listMembers, { householdId })).toHaveLength(1);
  });

  test("removing a member who is not on call leaves onCallUserId alone", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_m", "caregiver_member");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.removeMember, { householdId, userId: "user_m" });
    expect((await asA.query(api.households.get, { householdId })).onCallUserId).toBe("user_a");
  });

  test("a member can remove themselves and then loses access", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_v", "caregiver_viewer");
    const asViewer = t.withIdentity({ subject: "user_v" });
    await asViewer.mutation(api.households.removeMember, { householdId, userId: "user_v" });
    await expect(asViewer.query(api.households.get, { householdId })).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
  });

  test("removing a user who is not a member is not found", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await expect(
      t
        .withIdentity({ subject: "user_a" })
        .mutation(api.households.removeMember, { householdId, userId: "user_zzz" }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});

describe("join codes", () => {
  test("codes are 8 characters from the unambiguous alphabet and expire in 24 hours", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const before = Date.now();
    const { code, expiresAt, grants } = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.createJoinCode, { householdId, grants: "home_display" });
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(grants).toBe("home_display");
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 3_600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
  });

  test("members cannot create caregiver_primary codes but primaries can", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addCaregiver(t, householdId, "user_m", "caregiver_member");
    await expect(
      t
        .withIdentity({ subject: "user_m" })
        .mutation(api.households.createJoinCode, { householdId, grants: "caregiver_primary" }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await t
      .withIdentity({ subject: "user_m" })
      .mutation(api.households.createJoinCode, { householdId, grants: "caregiver_member" });
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.createJoinCode, { householdId, grants: "caregiver_primary" });
  });

  test("editors can list and delete codes", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    const asA = t.withIdentity({ subject: "user_a" });
    expect(await asA.query(api.households.listJoinCodes, { householdId })).toHaveLength(1);
    await asA.mutation(api.households.deleteJoinCode, { householdId, code });
    expect(await asA.query(api.households.listJoinCodes, { householdId })).toHaveLength(0);
    await expect(
      asA.mutation(api.households.deleteJoinCode, { householdId, code }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("listJoinCodes returns only unredeemed, unexpired codes", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const open = await makeCode(t, householdId, "caregiver_member");
    const used = await makeCode(t, householdId, "caregiver_viewer");
    const stale = await makeCode(t, householdId, "caregiver_viewer");
    await t.withIdentity({ subject: "user_b" }).mutation(api.households.redeemJoinCode, {
      code: used,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("joinCodes")
        .withIndex("by_code", (q) => q.eq("code", stale))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    const rows = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listJoinCodes, { householdId });
    expect(rows.map((r) => r.code)).toEqual([open]);
  });

  test("a code from another household cannot be deleted through this one", async () => {
    const t = makeBackend();
    const first = await createHousehold(t);
    const second = await t.withIdentity({ subject: "user_b" }).mutation(api.households.create, {
      seniorPreferredName: "Joe",
      timezone: NY,
      caregiverDisplayName: "Bea",
    });
    const { code } = await t
      .withIdentity({ subject: "user_b" })
      .mutation(api.households.createJoinCode, { householdId: second, grants: "caregiver_member" });
    await expect(
      t
        .withIdentity({ subject: "user_a" })
        .mutation(api.households.deleteJoinCode, { householdId: first, code }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("redeeming adds a member with the granted role and display name", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    const joined = await t
      .withIdentity({ subject: "user_b" })
      .mutation(api.households.redeemJoinCode, {
        code: `  ${code.toLowerCase()} `,
        displayName: "Ben",
      });
    expect(joined).toBe(householdId);
    const members = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listMembers, { householdId });
    expect(members.find((m) => m.userId === "user_b")).toMatchObject({
      role: "member",
      displayName: "Ben",
    });
  });

  test("display name defaults to Caregiver", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    await t.withIdentity({ subject: "user_b" }).mutation(api.households.redeemJoinCode, {
      code,
      displayName: "  ",
    });
    const members = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listMembers, { householdId });
    expect(members.find((m) => m.userId === "user_b")?.displayName).toBe("Caregiver");
  });

  test("a code is single use", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    await t.withIdentity({ subject: "user_b" }).mutation(api.households.redeemJoinCode, { code });
    await expect(
      t.withIdentity({ subject: "user_c" }).mutation(api.households.redeemJoinCode, { code }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("a code expires after 24 hours", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("joinCodes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      t.withIdentity({ subject: "user_b" }).mutation(api.households.redeemJoinCode, { code }),
    ).rejects.toMatchObject({
      data: { code: "not_found", message: "This code is invalid or has expired" },
    });
  });

  test("an unknown code is not found", async () => {
    const t = makeBackend();
    await expect(
      t.withIdentity({ subject: "user_b" }).mutation(api.households.redeemJoinCode, {
        code: "AAAAAAAA",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("redeemJoinCode rejects device codes and leaves them usable", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "senior_phone");
    await expect(
      t.withIdentity({ subject: "user_b" }).mutation(api.households.redeemJoinCode, { code }),
    ).rejects.toMatchObject({
      data: { code: "not_found", message: "This code is invalid or has expired" },
    });
    const paired = await t.mutation(internal.households.pairDevice, { code, userId: "device_1" });
    expect(paired.kind).toBe("senior_phone");
  });

  test("an existing member cannot redeem a second code", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    await expect(
      t.withIdentity({ subject: "user_a" }).mutation(api.households.redeemJoinCode, { code }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    const rows = await t.withIdentity({ subject: "user_a" }).query(api.households.listJoinCodes, {
      householdId,
    });
    expect(rows[0]?.redeemedAt).toBeUndefined();
  });

  test("a paired device cannot redeem a caregiver code", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await pairDevice(t, householdId, "device_1");
    const code = await makeCode(t, householdId, "caregiver_member");
    await expect(
      t.withIdentity({ subject: "device_1" }).mutation(api.households.redeemJoinCode, { code }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("redeeming requires sign in", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    await expect(t.mutation(api.households.redeemJoinCode, { code })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });
});

describe("pairDevice", () => {
  test("pairs a device with the kind from the code and marks the code used", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "home_display");
    const result = await t.mutation(internal.households.pairDevice, {
      code: code.toLowerCase(),
      userId: "device_1",
      name: "Kitchen",
    });
    expect(result).toMatchObject({ householdId, kind: "home_display" });
    const devices = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listDevices, { householdId });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ userId: "device_1", name: "Kitchen", kind: "home_display" });
    await expect(
      t.mutation(internal.households.pairDevice, { code, userId: "device_2" }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("rejects caregiver codes", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "caregiver_member");
    await expect(
      t.mutation(internal.households.pairDevice, { code, userId: "device_1" }),
    ).rejects.toMatchObject({
      data: { code: "not_found", message: "This code is invalid or has expired" },
    });
    // The code is not consumed: a caregiver can still redeem it.
    await t.withIdentity({ subject: "user_b" }).mutation(api.households.redeemJoinCode, { code });
  });

  test("rejects a user who is already a paired device", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await pairDevice(t, householdId, "device_1");
    const code = await makeCode(t, householdId, "senior_phone");
    await expect(
      t.mutation(internal.households.pairDevice, { code, userId: "device_1" }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("rejects a user who is already a caregiver", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "senior_phone");
    await expect(
      t.mutation(internal.households.pairDevice, { code, userId: "user_a" }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("rejects an expired code", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const code = await makeCode(t, householdId, "senior_phone");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("joinCodes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      t.mutation(internal.households.pairDevice, { code, userId: "device_1" }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});

describe("devices", () => {
  test("an editor can unpair a device", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const deviceId = await pairDevice(t, householdId, "device_1");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.removeDevice, { householdId, deviceId });
    expect(await asA.query(api.households.listDevices, { householdId })).toEqual([]);
    await expect(
      asA.mutation(api.households.removeDevice, { householdId, deviceId }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("a device of another household is not found", async () => {
    const t = makeBackend();
    const first = await createHousehold(t);
    const second = await t.withIdentity({ subject: "user_b" }).mutation(api.households.create, {
      seniorPreferredName: "Joe",
      timezone: NY,
      caregiverDisplayName: "Bea",
    });
    const own = await t.run(
      async (ctx) =>
        await ctx.db.insert("devices", {
          householdId: second,
          userId: "device_2",
          kind: "home_display",
        }),
    );
    await expect(
      t
        .withIdentity({ subject: "user_a" })
        .mutation(api.households.removeDevice, { householdId: first, deviceId: own }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});

describe("push tokens", () => {
  /**
   * purpose: All push token rows for a token value.
   * @param t: (TestConvex) Harness.
   * @param token: (string) Token.
   * @return: (Promise<string[]>) User ids that own the token.
   */
  async function owners(t: TestConvex, token: string): Promise<string[]> {
    return await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pushTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .collect();
      return rows.map((r) => r.userId);
    });
  }

  test("registering is idempotent for the same user", async () => {
    const t = makeBackend();
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.registerPushToken, { token: "tok_1" });
    await asA.mutation(api.households.registerPushToken, { token: "tok_1" });
    expect(await owners(t, "tok_1")).toEqual(["user_a"]);
  });

  test("a token registered to another user is not taken over", async () => {
    const t = makeBackend();
    await t.withIdentity({ subject: "user_a" }).mutation(api.households.registerPushToken, {
      token: "tok_1",
    });
    await expect(
      t.withIdentity({ subject: "user_b" }).mutation(api.households.registerPushToken, {
        token: "tok_1",
      }),
    ).rejects.toMatchObject({
      data: { code: "forbidden", message: "This push token belongs to another account" },
    });
    expect(await owners(t, "tok_1")).toEqual(["user_a"]);
  });

  test("unregister removes only the caller's own token", async () => {
    const t = makeBackend();
    await t.withIdentity({ subject: "user_a" }).mutation(api.households.registerPushToken, {
      token: "tok_1",
    });
    await t.withIdentity({ subject: "user_b" }).mutation(api.households.unregisterPushToken, {
      token: "tok_1",
    });
    expect(await owners(t, "tok_1")).toEqual(["user_a"]);
    await t.withIdentity({ subject: "user_a" }).mutation(api.households.unregisterPushToken, {
      token: "tok_1",
    });
    expect(await owners(t, "tok_1")).toEqual([]);
  });

  test("both require sign in and a non-blank token", async () => {
    const t = makeBackend();
    await expect(
      t.mutation(api.households.registerPushToken, { token: "tok_1" }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    await expect(
      t.mutation(api.households.unregisterPushToken, { token: "tok_1" }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    await expect(
      t.withIdentity({ subject: "user_a" }).mutation(api.households.registerPushToken, {
        token: " ",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });
});
