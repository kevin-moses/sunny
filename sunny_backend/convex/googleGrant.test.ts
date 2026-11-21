import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { GrantRow } from "./googleGrant";
import { addConnection, createHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

async function rowsOf(t: TestConvex): Promise<GrantRow[]> {
  const householdId = await createHousehold(t);
  const mailboxId = await t.run(
    async (ctx) =>
      await ctx.db.insert("mailboxes", {
        householdId,
        connectedBy: "user_a",
        accountEmail: "margaret@example.com",
        refreshToken: "box:refresh-1",
        status: "active",
        historyId: "100",
      }),
  );
  const connectionId = await addConnection(t, householdId);
  return [
    { table: "mailboxes", id: mailboxId },
    { table: "calendarConnections", id: connectionId },
  ];
}

async function stored(t: TestConvex, row: GrantRow) {
  return await t.run(async (ctx) => await ctx.db.get(row.id));
}

describe.each(["mailboxes", "calendarConnections"] as const)("a %s row", (table) => {
  async function setup() {
    const t = makeBackend();
    const row = (await rowsOf(t)).find((r) => r.table === table)!;
    return { t, row };
  }

  test("saves a refreshed access token for the grant it holds", async () => {
    const { t, row } = await setup();
    await t.mutation(internal.googleGrant.saveToken, {
      row,
      refreshToken: "box:refresh-1",
      accessToken: "box:access-2",
      expiresAt: 5,
    });
    expect(await stored(t, row)).toMatchObject({
      accessToken: "box:access-2",
      accessTokenExpiresAt: 5,
    });
  });

  test("ignores an access token from another grant", async () => {
    const { t, row } = await setup();
    await t.mutation(internal.googleGrant.saveToken, {
      row,
      refreshToken: "box:refresh-old",
      accessToken: "box:access-2",
      expiresAt: 5,
    });
    expect((await stored(t, row))?.accessToken).toBeUndefined();
  });

  test("a mark from another grant leaves the row active", async () => {
    const { t, row } = await setup();
    await t.mutation(internal.googleGrant.markGrant, {
      row,
      refreshToken: "box:refresh-old",
      status: "revoked",
      error: "gone",
    });
    expect(await stored(t, row)).toMatchObject({ status: "active" });
  });

  test("the first mark wins and a later one changes nothing", async () => {
    const { t, row } = await setup();
    for (const [status, error] of [
      ["revoked", "first"],
      ["error", "second"],
    ] as const) {
      await t.mutation(internal.googleGrant.markGrant, {
        row,
        refreshToken: "box:refresh-1",
        status,
        error,
      });
    }
    expect(await stored(t, row)).toMatchObject({ status: "revoked", error: "first" });
  });

  test("a row already in error is not moved to revoked and tells nobody", async () => {
    const { t, row } = await setup();
    await t.run(async (ctx) => ctx.db.patch(row.id, { status: "error", error: "earlier" }));
    await t.mutation(internal.googleGrant.markGrant, {
      row,
      refreshToken: "box:refresh-1",
      status: "revoked",
      error: "gone",
    });
    expect(await stored(t, row)).toMatchObject({ status: "error", error: "earlier" });
    expect(await t.run(async (ctx) => await ctx.db.query("chatPosts").collect())).toEqual([]);
  });
});

test("marking a mailbox tells the caregivers once and marking a calendar tells nobody", async () => {
  const t = makeBackend();
  const rows = await rowsOf(t);
  for (const row of rows) {
    await t.mutation(internal.googleGrant.markGrant, {
      row,
      refreshToken: "box:refresh-1",
      status: "revoked",
      error: "gone",
    });
  }
  const posts = await t.run(async (ctx) => await ctx.db.query("chatPosts").collect());
  expect(posts.map((p) => [p.kind, p.body])).toEqual([
    [
      "mailbox",
      "Sunny can no longer read margaret@example.com. Reconnect Gmail to keep mail coming in.",
    ],
  ]);
});
