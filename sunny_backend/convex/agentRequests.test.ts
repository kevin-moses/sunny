// agentRequests.test.ts
// Purpose: Tests for agentRequests.ts, the caregiver-facing API, with convex-test and the
// workflow component registered (timers are faked so no workflow step runs). Covers the rules
// ported from request_agent_chat: editor caregivers only (viewers, outsiders, devices and
// signed-out callers are refused for request, get, list and cancel), message trimmed and
// limited to 1 to 4000 characters, at most 5 queued or running requests per household, and
// continuing only a succeeded request of the same household that has a session. Also the
// inserted row, the stored workflow id, the audit entry, the view shape of get and list
// (null for absent fields, newest first, limit clamping) and cancel.
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createHousehold, insertRequest, makeBackend, type TestConvex } from "./testing.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * purpose: Create a household owned by user_a with a member and a viewer.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<Id<"households">>) The household.
 */
async function createTeam(t: TestConvex): Promise<Id<"households">> {
  const householdId = await createHousehold(t);
  await addMember(t, householdId, "user_member", "member");
  await addMember(t, householdId, "user_viewer", "viewer");
  return householdId;
}

/**
 * purpose: Insert a membership directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Clerk user id.
 * @param role: ("member" | "viewer") Role.
 */
async function addMember(
  t: TestConvex,
  householdId: Id<"households">,
  userId: string,
  role: "member" | "viewer",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("householdMembers", { householdId, userId, role, displayName: userId });
  });
}

describe("request", () => {
  test("queues a request, starts its workflow and audits it", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.agentRequests.request, { householdId, message: "  Add lunch at noon  " });
    const { row, audits } = await t.run(async (ctx) => ({
      row: await ctx.db.get(id),
      audits: await ctx.db
        .query("auditLog")
        .withIndex("by_household", (q) => q.eq("householdId", householdId))
        .collect(),
    }));
    expect(row).toMatchObject({
      householdId,
      requestedBy: "user_a",
      message: "Add lunch at noon",
      status: "queued",
    });
    expect(row?.workflowId).toBeTruthy();
    expect(audits.some((a) => a.action === "agent_request" && a.entityId === id)).toBe(true);
  });

  test("a member caregiver may request", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await t
      .withIdentity({ subject: "user_member" })
      .mutation(api.agentRequests.request, { householdId, message: "hi" });
    expect(id).toBeTruthy();
  });

  test("a viewer is refused", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    await expect(
      t
        .withIdentity({ subject: "user_viewer" })
        .mutation(api.agentRequests.request, { householdId, message: "hi" }),
    ).rejects.toThrow(/forbidden/);
  });

  test("an outsider and a signed-out caller are refused", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .mutation(api.agentRequests.request, { householdId, message: "hi" }),
    ).rejects.toThrow(/forbidden/);
    await expect(
      t.mutation(api.agentRequests.request, { householdId, message: "hi" }),
    ).rejects.toThrow(/unauthenticated/);
  });

  test("a paired senior device is refused", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("devices", { householdId, userId: "device_1", kind: "senior_phone" });
    });
    await expect(
      t
        .withIdentity({ subject: "device_1", sunny_kind: "device" })
        .mutation(api.agentRequests.request, { householdId, message: "hi" }),
    ).rejects.toThrow(/forbidden/);
  });

  test("rejects an empty or blank message", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const asA = t.withIdentity({ subject: "user_a" });
    await expect(
      asA.mutation(api.agentRequests.request, { householdId, message: "   " }),
    ).rejects.toThrow(/invalid/);
    await expect(
      asA.mutation(api.agentRequests.request, { householdId, message: "" }),
    ).rejects.toThrow(/invalid/);
  });

  test("accepts exactly 4000 characters and rejects 4001", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const asA = t.withIdentity({ subject: "user_a" });
    await expect(
      asA.mutation(api.agentRequests.request, { householdId, message: "a".repeat(4000) }),
    ).resolves.toBeTruthy();
    await expect(
      asA.mutation(api.agentRequests.request, { householdId, message: "a".repeat(4001) }),
    ).rejects.toThrow(/invalid/);
  });

  test("allows five in progress and refuses the sixth with a limit error", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    await insertRequest(t, householdId, { status: "running" });
    await insertRequest(t, householdId, { status: "running" });
    const asA = t.withIdentity({ subject: "user_a" });
    for (let i = 0; i < 3; i++) {
      await asA.mutation(api.agentRequests.request, { householdId, message: `m${i}` });
    }
    await expect(
      asA.mutation(api.agentRequests.request, { householdId, message: "one too many" }),
    ).rejects.toThrow(/limit/);
  });

  test("finished requests do not count toward the limit", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      for (let i = 0; i < 3; i++) await insertRequest(t, householdId, { status });
    }
    await expect(
      t
        .withIdentity({ subject: "user_a" })
        .mutation(api.agentRequests.request, { householdId, message: "ok" }),
    ).resolves.toBeTruthy();
  });

  test("the limit is per household", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const other = await createHousehold(t, { seniorName: "Bob" });
    for (let i = 0; i < 5; i++) await insertRequest(t, other, { status: "queued" });
    await expect(
      t
        .withIdentity({ subject: "user_a" })
        .mutation(api.agentRequests.request, { householdId, message: "ok" }),
    ).resolves.toBeTruthy();
  });

  describe("continuing", () => {
    test("continues a succeeded request that has a session", async () => {
      const t = makeBackend();
      const householdId = await createTeam(t);
      const earlier = await insertRequest(t, householdId, { status: "succeeded", sessionId: "s1" });
      const id = await t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.request, {
        householdId,
        message: "and one more",
        continueRequestId: earlier,
      });
      const row = await t.run(async (ctx) => await ctx.db.get(id));
      expect(row?.continueRequestId).toBe(earlier);
    });

    test("copies the earlier session id onto the new request", async () => {
      const t = makeBackend();
      const householdId = await createTeam(t);
      const earlier = await insertRequest(t, householdId, { status: "succeeded", sessionId: "s1" });
      const id = await t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.request, {
        householdId,
        message: "more",
        continueRequestId: earlier,
      });
      const row = await t.run(async (ctx) => await ctx.db.get(id));
      expect(row?.sessionId).toBe("s1");
    });

    test.each(["queued", "running"] as const)(
      "refuses a continuation while another %s request uses the session",
      async (status) => {
        const t = makeBackend();
        const householdId = await createTeam(t);
        const earlier = await insertRequest(t, householdId, {
          status: "succeeded",
          sessionId: "s1",
        });
        await insertRequest(t, householdId, { status, sessionId: "s1" });
        await expect(
          t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.request, {
            householdId,
            message: "more",
            continueRequestId: earlier,
          }),
        ).rejects.toThrow(/still working on that conversation/);
      },
    );

    test("two continuations of the same request cannot both start", async () => {
      const t = makeBackend();
      const householdId = await createTeam(t);
      const earlier = await insertRequest(t, householdId, { status: "succeeded", sessionId: "s1" });
      const asA = t.withIdentity({ subject: "user_a" });
      await asA.mutation(api.agentRequests.request, {
        householdId,
        message: "first",
        continueRequestId: earlier,
      });
      await expect(
        asA.mutation(api.agentRequests.request, {
          householdId,
          message: "second",
          continueRequestId: earlier,
        }),
      ).rejects.toThrow(/limit/);
    });

    test.each(["queued", "running", "failed", "cancelled"] as const)(
      "refuses to continue a %s request",
      async (status) => {
        const t = makeBackend();
        const householdId = await createTeam(t);
        const earlier = await insertRequest(t, householdId, { status, sessionId: "s1" });
        await expect(
          t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.request, {
            householdId,
            message: "more",
            continueRequestId: earlier,
          }),
        ).rejects.toThrow(/not_found/);
      },
    );

    test("refuses to continue a succeeded request without a session", async () => {
      const t = makeBackend();
      const householdId = await createTeam(t);
      const earlier = await insertRequest(t, householdId, { status: "succeeded" });
      await expect(
        t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.request, {
          householdId,
          message: "more",
          continueRequestId: earlier,
        }),
      ).rejects.toThrow(/not_found/);
    });

    test("refuses to continue another household's request", async () => {
      const t = makeBackend();
      const householdId = await createTeam(t);
      const other = await createHousehold(t, { seniorName: "Bob" });
      const earlier = await insertRequest(t, other, { status: "succeeded", sessionId: "s1" });
      await expect(
        t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.request, {
          householdId,
          message: "more",
          continueRequestId: earlier,
        }),
      ).rejects.toThrow(/not_found/);
    });
  });
});

describe("get and list", () => {
  test("get returns a view with null for absent fields", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await insertRequest(t, householdId);
    const view = await t.withIdentity({ subject: "user_member" }).query(api.agentRequests.get, {
      requestId: id,
    });
    expect(view).toMatchObject({
      id,
      householdId,
      requestedBy: "user_a",
      message: "hello",
      continueRequestId: null,
      status: "queued",
      reply: null,
      error: null,
      finishedAt: null,
    });
    expect(typeof view.createdAt).toBe("number");
    expect(Object.keys(view)).not.toContain("workflowId");
    expect(Object.keys(view)).not.toContain("sessionId");
  });

  test("get returns the reply of a succeeded request", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await insertRequest(t, householdId, {
      status: "succeeded",
      reply: "Done.",
      finishedAt: 5,
    });
    const view = await t.withIdentity({ subject: "user_a" }).query(api.agentRequests.get, {
      requestId: id,
    });
    expect(view).toMatchObject({ status: "succeeded", reply: "Done.", finishedAt: 5 });
  });

  test("get refuses viewers and outsiders", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await insertRequest(t, householdId);
    for (const subject of ["user_viewer", "stranger"]) {
      await expect(
        t.withIdentity({ subject }).query(api.agentRequests.get, { requestId: id }),
      ).rejects.toThrow(/forbidden/);
    }
  });

  test("get reports not_found for a deleted request", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await insertRequest(t, householdId);
    await t.run(async (ctx) => await ctx.db.delete(id));
    await expect(
      t.withIdentity({ subject: "user_a" }).query(api.agentRequests.get, { requestId: id }),
    ).rejects.toThrow(/not_found/);
  });

  test("list returns newest first and only this household's requests", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const other = await createHousehold(t, { seniorName: "Bob" });
    const first = await insertRequest(t, householdId);
    const second = await insertRequest(t, householdId);
    await insertRequest(t, other);
    const rows = await t
      .withIdentity({ subject: "user_a" })
      .query(api.agentRequests.list, { householdId });
    expect(rows.map((r) => r.id)).toEqual([second, first]);
  });

  test("list honours the limit and clamps it to 1..100", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    for (let i = 0; i < 3; i++) await insertRequest(t, householdId);
    const asA = t.withIdentity({ subject: "user_a" });
    expect(await asA.query(api.agentRequests.list, { householdId, limit: 2 })).toHaveLength(2);
    expect(await asA.query(api.agentRequests.list, { householdId, limit: 0 })).toHaveLength(1);
    expect(await asA.query(api.agentRequests.list, { householdId, limit: 1000 })).toHaveLength(3);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "list falls back to the default for a non-finite limit (%s)",
    async (limit) => {
      const t = makeBackend();
      const householdId = await createTeam(t);
      for (let i = 0; i < 3; i++) await insertRequest(t, householdId);
      const rows = await t
        .withIdentity({ subject: "user_a" })
        .query(api.agentRequests.list, { householdId, limit });
      expect(rows).toHaveLength(3);
    },
  );

  test("list refuses viewers", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    await expect(
      t.withIdentity({ subject: "user_viewer" }).query(api.agentRequests.list, { householdId }),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("cancel", () => {
  test("cancels a queued request started through request", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const asA = t.withIdentity({ subject: "user_a" });
    const id = await asA.mutation(api.agentRequests.request, { householdId, message: "hi" });
    await asA.mutation(api.agentRequests.cancel, { requestId: id });
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.status).toBe("cancelled");
    expect(row?.finishedAt).toBeTypeOf("number");
  });

  test("cancels a running request without a workflow id", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await insertRequest(t, householdId, { status: "running" });
    await t.withIdentity({ subject: "user_member" }).mutation(api.agentRequests.cancel, {
      requestId: id,
    });
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.status).toBe("cancelled");
  });

  test.each(["succeeded", "failed", "cancelled"] as const)(
    "refuses to cancel a %s request",
    async (status) => {
      const t = makeBackend();
      const householdId = await createTeam(t);
      const id = await insertRequest(t, householdId, { status });
      await expect(
        t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.cancel, { requestId: id }),
      ).rejects.toThrow(/invalid/);
    },
  );

  test("refuses viewers and outsiders", async () => {
    const t = makeBackend();
    const householdId = await createTeam(t);
    const id = await insertRequest(t, householdId, { status: "running" });
    for (const subject of ["user_viewer", "stranger"]) {
      await expect(
        t.withIdentity({ subject }).mutation(api.agentRequests.cancel, { requestId: id }),
      ).rejects.toThrow(/forbidden/);
    }
  });
});
