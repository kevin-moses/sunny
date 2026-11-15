import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DONE_INSTANCE_HEADER } from "./deviceFrame";
import { loadDeviceState } from "./lib/deviceState";
import { DEFAULT_SCREEN, drawFrame, renderFrame } from "./lib/frame";
import type { Screen } from "./lib/frame";
import { decodePacked } from "./lib/framePackedDecoder.helpers";
import { encodePng } from "./lib/framePng";
import schema from "./schema";

vi.mock("./lib/frame", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/frame")>();
  return { ...original, drawFrame: vi.fn(original.drawFrame) };
});

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const START = "2026-11-13T13:10:00Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(START));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeBackend() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  workpoolTest.register(t, "deliveryPool");
  return t;
}

type TestConvex = ReturnType<typeof makeBackend>;

async function household(
  t: TestConvex,
  prefix: string,
  label: string,
): Promise<{
  householdId: Id<"households">;
  instanceId: Id<"taskInstances">;
  token: string;
  phoneToken: string;
}> {
  const caregiver = t.withIdentity({ subject: `${prefix}pat` });
  const householdId = await caregiver.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    caregiverDisplayName: "Pat",
  });
  for (const [grants, userId] of [
    ["home_display", `${prefix}display`],
    ["senior_phone", `${prefix}phone`],
  ] as const) {
    const { code } = await caregiver.mutation(api.households.createJoinCode, {
      householdId,
      grants,
    });
    await t.mutation(internal.households.pairDevice, { code, userId });
  }
  await caregiver.mutation(api.tasks.create, {
    householdId,
    type: "medication",
    title: label,
    displayLabel: label,
    times: ["08:00"],
  });
  const instance = await t.run(async (ctx) =>
    ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) =>
        q.eq("householdId", householdId).eq("localDate", "2026-11-13"),
      )
      .first(),
  );
  const issue = async (subject: string): Promise<string> =>
    (await t.withIdentity({ subject }).action(api.deviceApi.issueToken, {})).deviceToken;
  return {
    householdId,
    instanceId: instance!._id,
    token: await issue(`${prefix}display`),
    phoneToken: await issue(`${prefix}phone`),
  };
}

async function confirm(
  t: TestConvex,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: string; reason: string | null }> {
  const res = await t.fetch("/device/confirm", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { status: string; reason: string | null };
}

async function stateOf(
  t: TestConvex,
  instanceId: Id<"taskInstances">,
): Promise<string | undefined> {
  return (await t.run(async (ctx) => await ctx.db.get(instanceId)))?.state;
}

async function getFrame(
  t: TestConvex,
  token: string | null,
  query: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const all = { ...headers };
  if (token !== null) all.Authorization = `Bearer ${token}`;
  return await t.fetch(`/device/frame?${query}`, { method: "GET", headers: all });
}

async function reportScreen(t: TestConvex, token: string, screen: Screen): Promise<void> {
  const res = await t.fetch("/device/info", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ screen }),
  });
  expect(res.status).toBe(204);
}

function pngSize(png: Uint8Array): [number, number, number] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20), png[24]!];
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

const EARLY_HOUR = Date.parse("2026-11-13T12:40:00Z");

const UNKNOWN_TOKEN = `sunny_dev_${"Q".repeat(43)}`;

describe("GET /device/frame", () => {
  test("draws a PNG of the default screen, with no-store and an ETag", async () => {
    const t = makeBackend();
    const { token } = await household(t, "", "Morning pills");
    const res = await getFrame(t, token, "page=now&format=png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{16}"$/);
    expect(pngSize(await bytesOf(res))).toEqual([DEFAULT_SCREEN.width, DEFAULT_SCREEN.height, 2]);
  });

  test("draws for the screen the device reported, in either format", async () => {
    const t = makeBackend();
    const { token } = await household(t, "", "Morning pills");
    await reportScreen(t, token, { width: 800, height: 480, greys: 2 });
    const png = await getFrame(t, token, "page=today&format=png");
    expect(pngSize(await bytesOf(png))).toEqual([800, 480, 1]);
    const packed = await getFrame(t, token, "format=packed&page=today");
    expect(packed.headers.get("Content-Type")).toBe("application/octet-stream");
    const frame = decodePacked(await bytesOf(packed));
    expect([frame.width, frame.height, frame.greys]).toEqual([800, 480, 2]);
  });

  test("answers a matching If-None-Match with 304; the ETag differs by page and format", async () => {
    const t = makeBackend();
    const { token } = await household(t, "", "Morning pills");
    const res = await getFrame(t, token, "page=now&format=png");
    const etag = res.headers.get("ETag")!;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const cached = await getFrame(t, token, "page=now&format=png", { "If-None-Match": header });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
      expect(cached.headers.get("ETag")).toBe(etag);
      expect(cached.headers.get("Cache-Control")).toBe("no-store");
    }
    const tags = await Promise.all(
      ["page=today&format=png", "page=now&format=packed", "page=today&format=packed"].map(
        async (q) => (await getFrame(t, token, q)).headers.get("ETag"),
      ),
    );
    expect(new Set([etag, ...tags]).size).toBe(4);
  });

  test("a change to what is drawn changes the ETag; a minute passing does not", async () => {
    const t = makeBackend();
    const { token, instanceId } = await household(t, "", "Morning pills");
    const before = (await getFrame(t, token, "page=now&format=png")).headers.get("ETag")!;
    vi.setSystemTime(new Date(Date.parse(START) + 60_000));
    const same = await getFrame(t, token, "page=now&format=png", { "If-None-Match": before });
    expect(same.status).toBe(304);
    await t.run(async (ctx) => await ctx.db.patch(instanceId, { state: "due" }));
    const after = await getFrame(t, token, "page=now&format=png", { "If-None-Match": before });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(before);
  });

  test("a device gets only its own household's frame", async () => {
    const t = makeBackend();
    const a = await household(t, "a-", "Morning pills");
    const b = await household(t, "b-", "Water the garden");
    for (const h of [a, b]) {
      await t.run(async (ctx) => await ctx.db.patch(h.instanceId, { state: "due" }));
    }
    const states = await t.run(async (ctx) => ({
      a: await loadDeviceState(ctx, a.householdId, Date.now()),
      b: await loadDeviceState(ctx, b.householdId, Date.now()),
    }));
    const expected = {
      a: encodePng(renderFrame(states.a, DEFAULT_SCREEN, "now")),
      b: encodePng(renderFrame(states.b, DEFAULT_SCREEN, "now")),
    };
    expect(Buffer.from(expected.a).equals(Buffer.from(expected.b))).toBe(false);
    for (const [h, want] of [
      [a, expected.a],
      [b, expected.b],
    ] as const) {
      const got = await bytesOf(await getFrame(t, h.token, "page=now&format=png"));
      expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
    }
  });

  test("refuses a bad query with 400, after the token", async () => {
    const t = makeBackend();
    const { token } = await household(t, "", "Morning pills");
    for (const query of [
      "",
      "page=now",
      "format=png",
      "page=later&format=png",
      "page=now&format=gif",
      "page=now&format=constructor",
      "page=now&page=today&format=png",
      "page=now&format=png&format=packed",
      "page=now&format=png&step=1",
    ]) {
      const res = await getFrame(t, token, query);
      expect(res.status, query).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await getFrame(t, null, "page=later")).status).toBe(401);
  });

  test("refuses a reported screen frames are not drawn for", async () => {
    const t = makeBackend();
    const { token } = await household(t, "", "Morning pills");
    await reportScreen(t, token, { width: 4000, height: 3000, greys: 16 });
    const res = await getFrame(t, token, "page=now&format=packed");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "2048 x 2048",
    );
  });

  test("401 without a valid token", async () => {
    const t = makeBackend();
    await household(t, "", "Morning pills");
    for (const token of [null, UNKNOWN_TOKEN]) {
      const res = await getFrame(t, token, "page=now&format=png");
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("spends the device's request bucket like every device route", async () => {
    const t = makeBackend();
    const { token } = await household(t, "", "Morning pills");
    for (let i = 0; i < 120; i += 1) {
      await t.fetch("/device/state", { headers: { Authorization: `Bearer ${token}` } });
    }
    const res = await getFrame(t, token, "page=now&format=png");
    expect(res.status).toBe(429);
  });

  test("uses the token's own device's screen, not another device's of the household", async () => {
    const t = makeBackend();
    const { token, phoneToken } = await household(t, "", "Morning pills");
    await reportScreen(t, phoneToken, { width: 800, height: 480, greys: 2 });
    const display = await bytesOf(await getFrame(t, token, "page=now&format=png"));
    expect(pngSize(display)).toEqual([960, 680, 2]);
    const phone = await bytesOf(await getFrame(t, phoneToken, "page=now&format=png"));
    expect(pngSize(phone)).toEqual([800, 480, 1]);
  });

  test("answers a matching If-None-Match without drawing", async () => {
    const t = makeBackend();
    const { token } = await household(t, "", "Morning pills");
    const drawn = vi.mocked(drawFrame);
    const before = drawn.mock.calls.length;
    const res = await getFrame(t, token, "page=today&format=packed");
    expect(drawn.mock.calls.length).toBe(before + 1);
    const etag = res.headers.get("ETag")!;
    const cached = await getFrame(t, token, "page=today&format=packed", { "If-None-Match": etag });
    expect(cached.status).toBe(304);
    expect(drawn.mock.calls.length).toBe(before + 1);
  });

  test("names the task Done confirms on 200 and 304, and none while it is early", async () => {
    const t = makeBackend();
    const { token, instanceId } = await household(t, "", "Morning pills");
    const early = await getFrame(t, token, "page=now&format=png");
    expect(early.headers.get(DONE_INSTANCE_HEADER)).toBeNull();
    const earlyCached = await getFrame(t, token, "page=now&format=png", {
      "If-None-Match": early.headers.get("ETag")!,
    });
    expect(earlyCached.status).toBe(304);
    expect(earlyCached.headers.get(DONE_INSTANCE_HEADER)).toBeNull();
    await t.run(async (ctx) => await ctx.db.patch(instanceId, { state: "due" }));
    for (const page of ["now", "today"]) {
      const due = await getFrame(t, token, `page=${page}&format=packed`);
      expect(due.headers.get(DONE_INSTANCE_HEADER)).toBe(instanceId);
      const cached = await getFrame(t, token, `page=${page}&format=packed`, {
        "If-None-Match": due.headers.get("ETag")!,
      });
      expect(cached.status).toBe(304);
      expect(cached.headers.get(DONE_INSTANCE_HEADER)).toBe(instanceId);
    }
    await t.run(async (ctx) => await ctx.db.patch(instanceId, { state: "confirmed" }));
    const done = await getFrame(t, token, "page=now&format=png");
    expect(done.headers.get(DONE_INSTANCE_HEADER)).toBeNull();
  });
});

describe("the hardware Done key (POST /device/confirm via button)", () => {
  test("refuses a task that is not due yet, audited, and leaves it alone", async () => {
    const t = makeBackend();
    vi.setSystemTime(new Date(EARLY_HOUR));
    const { token, instanceId } = await household(t, "", "Morning pills");
    const answer = await confirm(t, token, { instanceId, pressedAgoMs: 0, via: "button" });
    expect(answer).toMatchObject({ status: "rejected", reason: "This task is not due yet" });
    expect(await stateOf(t, instanceId)).toBe("upcoming");
    const rows = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const refused = rows.filter((r) => r.action === "press_not_applied");
    expect(refused.map((r) => (r.detail as { reason: string }).reason)).toEqual([
      "This task is not due yet",
    ]);
  });

  test("audits at most 20 such refusals an hour, then answers without a row", async () => {
    const t = makeBackend();
    vi.setSystemTime(new Date(EARLY_HOUR));
    const { token, instanceId } = await household(t, "", "Morning pills");
    for (let i = 0; i < 22; i += 1) {
      const answer = await confirm(t, token, { instanceId, pressedAgoMs: 0, via: "button" });
      expect(answer.reason).toBe("This task is not due yet");
    }
    const rows = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(rows.filter((r) => r.action === "press_not_applied")).toHaveLength(20);
  });

  test("a press after the window opened confirms, even before the scheduler marks it due", async () => {
    const t = makeBackend();
    const { token, instanceId } = await household(t, "", "Morning pills");
    expect(await stateOf(t, instanceId)).toBe("upcoming");
    const answer = await confirm(t, token, { instanceId, pressedAgoMs: 0, via: "button" });
    expect(answer.status).toBe("confirmed");
    expect(await stateOf(t, instanceId)).toBe("confirmed");
  });

  test("a queued button press made before the window is refused even after it opened", async () => {
    const t = makeBackend();
    const { token, instanceId } = await household(t, "", "Morning pills");
    const answer = await confirm(t, token, {
      instanceId,
      pressedAgoMs: 20 * 60_000,
      via: "button",
    });
    expect(answer).toMatchObject({ status: "rejected", reason: "This task is not due yet" });
  });

  test("allows 5 minutes for the device's clock: 4 minutes early counts, 6 is refused", async () => {
    const t = makeBackend();
    const { token, instanceId } = await household(t, "", "Morning pills");
    const sixEarly = await confirm(t, token, {
      instanceId,
      pressedAgoMs: 16 * 60_000,
      via: "button",
    });
    expect(sixEarly).toMatchObject({ status: "rejected", reason: "This task is not due yet" });
    expect(await stateOf(t, instanceId)).toBe("upcoming");
    const fourEarly = await confirm(t, token, {
      instanceId,
      pressedAgoMs: 14 * 60_000,
      via: "button",
    });
    expect(fourEarly.status).toBe("confirmed");
    expect(await stateOf(t, instanceId)).toBe("confirmed");
  });

  test("a queued press made before the window is refused after the task came due", async () => {
    const t = makeBackend();
    const { token, instanceId } = await household(t, "", "Morning pills");
    await t.run(async (ctx) => await ctx.db.patch(instanceId, { state: "due" }));
    const answer = await confirm(t, token, {
      instanceId,
      pressedAgoMs: 20 * 60_000,
      via: "button",
    });
    expect(answer).toMatchObject({ status: "rejected", reason: "This task is not due yet" });
    expect(await stateOf(t, instanceId)).toBe("due");
  });

  test("the phone's surfaces keep their early hour", async () => {
    const t = makeBackend();
    vi.setSystemTime(new Date(EARLY_HOUR));
    const { phoneToken, instanceId } = await household(t, "", "Morning pills");
    const answer = await confirm(t, phoneToken, { instanceId, pressedAgoMs: 0, via: "widget" });
    expect(answer.status).toBe("confirmed");
  });
});
