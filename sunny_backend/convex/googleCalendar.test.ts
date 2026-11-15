import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { googleMocks, resetGoogleMocks } from "./googleMocks.helpers";
import { signState } from "./lib/google";
import { FLOW_COOKIE, sha256Base64Url } from "./lib/oauthFlow";
import {
  addCalendarEvent,
  addConnection,
  addMember,
  createHousehold,
  makeBackend,
  pendingScheduled,
  runFanOut,
  setupSynced,
  syncRows,
} from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

vi.mock("./lib/google", async (original) =>
  (await import("./googleMocks.helpers")).googleMock(await original()),
);
vi.mock("./lib/googleEvent", async () => (await import("./googleMocks.helpers")).googleEventMock);
vi.mock("./lib/secretBox", async (original) =>
  (await import("./googleMocks.helpers")).secretBoxMock(await original()),
);

const TEST_ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_REDIRECT_URI: "https://sunny.test/google/callback",
  GOOGLE_OAUTH_STATE_SECRET: "state-secret",
};
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  resetGoogleMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const [name, value] of Object.entries(TEST_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const name of Object.keys(TEST_ENV)) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

interface StartedFlow {
  res: Response;
  setCookie: string;
  cookie: string;
  secret: string;
  state: string;
  flowId: string;
  challenge: string;
}

async function connectUrl(
  t: TestConvex,
  householdId: Id<"households">,
  userId = "user_a",
): Promise<URL> {
  return new URL(
    await t
      .withIdentity({ subject: userId })
      .action(api.googleCalendar.connectUrl, { householdId }),
  );
}

async function connectPath(
  t: TestConvex,
  householdId: Id<"households">,
  userId = "user_a",
): Promise<string> {
  const url = await connectUrl(t, householdId, userId);
  return `${url.pathname}${url.search}`;
}

function startedFrom(res: Response): StartedFlow {
  expect(res.status).toBe(302);
  const consent = new URL(res.headers.get("Location")!);
  const setCookie = res.headers.get("Set-Cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const state = consent.searchParams.get("state")!;
  return {
    res,
    setCookie,
    cookie,
    secret: cookie.slice(FLOW_COOKIE.length + 1),
    state,
    flowId: state.split(".")[0]!,
    challenge: consent.searchParams.get("code_challenge")!,
  };
}

async function startFlow(
  t: TestConvex,
  householdId: Id<"households">,
  userId = "user_a",
): Promise<StartedFlow> {
  return startedFrom(await t.fetch(await connectPath(t, householdId, userId)));
}

function finish(
  t: TestConvex,
  flow: { state: string; cookie: string | null },
  code = "c",
): Promise<Response> {
  return t.fetch(`/google/callback?code=${code}&state=${encodeURIComponent(flow.state)}`, {
    headers: flow.cookie === null ? {} : { Cookie: flow.cookie },
  });
}

async function refusals(t: TestConvex): Promise<unknown[]> {
  const rows = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
  return rows.filter((r) => r.action === "connect_refused").map((r) => r.detail.reason);
}

async function storedState(t: TestConvex) {
  return await t.run(async (ctx) => ({
    connections: await ctx.db.query("calendarConnections").collect(),
    flows: await ctx.db.query("oauthFlows").collect(),
  }));
}

async function expectBurnedFlowAndNothingSaved(t: TestConvex): Promise<void> {
  const { connections, flows } = await storedState(t);
  expect(connections).toHaveLength(0);
  expect(flows.every((f) => f.consumedAt !== undefined)).toBe(true);
}

function expectExpiresIn(expiresAt: number, ms: number): void {
  expect(expiresAt - Date.now()).toBeGreaterThanOrEqual(ms);
  expect(expiresAt - Date.now()).toBeLessThan(ms + 1000);
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Link expired");
}

async function readyHousehold(t: TestConvex, seniorName = "Margaret") {
  const householdId = await createHousehold(t, { seniorName });
  googleMocks.exchangeCode.mockResolvedValue({
    accessToken: "acc",
    refreshToken: "refresh-new",
    scopes: ["https://www.googleapis.com/auth/calendar.app.created"],
    email: "anna@example.com",
  });
  googleMocks.createSunnyCalendar.mockResolvedValue("cal-new");
  return householdId;
}

describe("Starting the Google flow", () => {
  test("connectUrl gives a start link on the callback host and stores only the ticket's hash", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const link = await connectUrl(t, householdId);
    expect(link.origin + link.pathname).toBe("https://sunny.test/google/start");
    const ticket = link.searchParams.get("ticket")!;
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { flows } = await storedState(t);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({
      ticketHash: await sha256Base64Url(ticket),
      userId: "user_a",
      householdId,
    });
    expectExpiresIn(flows[0]!.expiresAt, 5 * 60_000);
    expect(JSON.stringify(flows)).not.toContain(ticket);
    const again = await connectUrl(t, householdId);
    expect(again.searchParams.get("ticket")).not.toBe(ticket);
  });

  test("the start route sets the browser cookie and redirects to Google with an S256 challenge", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const flow = await startFlow(t, householdId);
    const consent = new URL(flow.res.headers.get("Location")!);
    expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.setCookie.startsWith(`${FLOW_COOKIE}=`)).toBe(true);
    for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) {
      expect(flow.setCookie).toContain(attribute);
    }
    expect(flow.setCookie).not.toContain("Domain");
    const [row] = (await storedState(t)).flows;
    expect(flow.flowId).toBe(row!._id);
    expect(flow.state).toBe(await signState(row!._id));
    expect(row!.started?.browserHash).toBe(await sha256Base64Url(flow.secret));
    expect(row!.started?.codeVerifier).toMatch(/^box:/);
    expect(await sha256Base64Url(row!.started!.codeVerifier.slice(4))).toBe(flow.challenge);
    expectExpiresIn(row!.expiresAt, 10 * 60_000);
  });

  test("a ticket works once: a second start is refused and audited", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const link = await connectPath(t, householdId);
    expect((await t.fetch(link)).status).toBe(302);
    const again = await t.fetch(link);
    await expectRefused(again);
    expect(again.headers.get("Set-Cookie")).toBeNull();
    expect(await refusals(t)).toEqual(["ticket_reused"]);
  });

  test("a ticket older than five minutes is refused and audited", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const link = await connectPath(t, householdId);
    vi.advanceTimersByTime(6 * 60_000);
    await expectRefused(await t.fetch(link));
    expect(await refusals(t)).toEqual(["ticket_expired"]);
    expect((await storedState(t)).flows[0]?.started).toBeUndefined();
  });

  test.each([
    ["an unknown ticket", "/google/start?ticket=nope"],
    ["no ticket", "/google/start"],
  ])("%s is refused", async (_label, path) => {
    const t = makeBackend();
    await createHousehold(t);
    const res = await t.fetch(path);
    await expectRefused(res);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("a device is refused, with or without the device claim", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("devices", { householdId, userId: "dev_1", kind: "home_display" });
    });
    await expect(
      t
        .withIdentity({ subject: "dev_1", sunny_kind: "device" })
        .action(api.googleCalendar.connectUrl, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t.withIdentity({ subject: "dev_1" }).action(api.googleCalendar.connectUrl, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("connectUrl stores nothing when the redirect URI is not configured", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    delete process.env.GOOGLE_REDIRECT_URI;
    await expect(connectUrl(t, householdId)).rejects.toThrow("GOOGLE_REDIRECT_URI");
    expect((await storedState(t)).flows).toHaveLength(0);
  });

  test("a non-member and a signed-out caller are refused", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await expect(connectUrl(t, householdId, "stranger")).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    await expect(t.action(api.googleCalendar.connectUrl, { householdId })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
    expect((await storedState(t)).flows).toHaveLength(0);
  });

  test("a misconfiguration while starting shows the generic error page and sets no cookie", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const link = await connectPath(t, householdId);
    delete process.env.GOOGLE_OAUTH_STATE_SECRET;
    const res = await t.fetch(link);
    expect(res.status).toBe(500);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).not.toContain("GOOGLE_OAUTH_STATE_SECRET");
  });
});

describe("OAuth callback", () => {
  test("saves an encrypted connection and queues every live event and linked cancelled one", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const live = await addCalendarEvent(t, householdId, "Live");
    const unlinkedCancelled = await addCalendarEvent(t, householdId, "Cancelled, never synced");
    const linkedCancelled = await addCalendarEvent(t, householdId, "Cancelled, synced");
    const asA = t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.calendar.cancelEvent, { householdId, eventId: unlinkedCancelled });
    await asA.mutation(api.calendar.cancelEvent, { householdId, eventId: linkedCancelled });

    const res = await finish(t, await startFlow(t, householdId));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Google Calendar connected");
    expect(googleMocks.createSunnyCalendar).toHaveBeenCalledWith(
      "acc",
      "Margaret",
      "America/New_York",
    );

    const { connections, flows } = await storedState(t);
    const connection = connections[0];
    expect(connection).toMatchObject({
      userId: "user_a",
      householdId,
      accountEmail: "anna@example.com",
      externalCalendarId: "cal-new",
      status: "active",
      refreshToken: "box:refresh-new",
    });
    expect(flows[0]?.consumedAt).toBeDefined();
    expect(await refusals(t)).toEqual([]);
    expect(await syncRows(t)).toHaveLength(0);
    expect(await pendingScheduled(t)).toContain("calendarFanOut:chunk");
    await runFanOut(t, householdId, connection!._id);
    expect((await syncRows(t)).map((s) => s.eventId)).toEqual([live]);

    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId: linkedCancelled,
        connectionId: connection!._id,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    googleMocks.calendarExists.mockResolvedValue(true);
    await finish(t, await startFlow(t, householdId), "c2");
    await runFanOut(t, householdId, connection!._id);
    const queued = (await syncRows(t)).map((s) => s.eventId).sort();
    expect(queued).toEqual([live, linkedCancelled].sort());
    expect(googleMocks.createSunnyCalendar).toHaveBeenCalledTimes(1);
  });

  test("the code is exchanged with the verifier behind the challenge sent to Google", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    expect((await finish(t, flow, "the-code")).status).toBe(200);
    expect(googleMocks.exchangeCode).toHaveBeenCalledTimes(1);
    const [code, verifier] = googleMocks.exchangeCode.mock.calls[0]!;
    expect(code).toBe("the-code");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sha256Base64Url(verifier)).toBe(flow.challenge);
  });

  test("every callback answer clears the browser cookie", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    for (const res of [
      await finish(t, flow),
      await finish(t, flow),
      await t.fetch("/google/callback?error=denied"),
    ]) {
      const cleared = res.headers.get("Set-Cookie")!;
      expect(cleared.startsWith(`${FLOW_COOKIE}=;`)).toBe(true);
      expect(cleared).toContain("Max-Age=0");
    }
  });

  test("a callback without the browser cookie is refused, audited and burns the flow", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    await expectRefused(await finish(t, { state: flow.state, cookie: null }));
    await expectRefused(await finish(t, flow));
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
    await expectBurnedFlowAndNothingSaved(t);
    expect(await refusals(t)).toEqual(["no_browser_cookie", "flow_used"]);
  });

  test("a callback carrying another browser's cookie is refused and audited", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const victim = await startFlow(t, householdId);
    const attacker = await startFlow(t, householdId);
    await expectRefused(await finish(t, { state: victim.state, cookie: attacker.cookie }));
    await expectRefused(await finish(t, { state: victim.state, cookie: `${FLOW_COOKIE}=forged` }));
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
    expect((await storedState(t)).connections).toHaveLength(0);
    expect(await refusals(t)).toEqual(["wrong_browser", "flow_used"]);
  });

  test("a replayed callback is refused and audited", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    expect((await finish(t, flow)).status).toBe(200);
    await expectRefused(await finish(t, flow));
    expect(googleMocks.exchangeCode).toHaveBeenCalledTimes(1);
    expect(await refusals(t)).toEqual(["flow_used"]);
  });

  test("a flow older than ten minutes is refused and audited", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    vi.advanceTimersByTime(11 * 60_000);
    await expectRefused(await finish(t, flow));
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
    await expectBurnedFlowAndNothingSaved(t);
    expect(await refusals(t)).toEqual(["flow_expired"]);
  });

  test("a callback for a flow never started in a browser is refused", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    await connectPath(t, householdId);
    const [row] = (await storedState(t)).flows;
    await expectRefused(
      await finish(t, { state: await signState(row!._id), cookie: `${FLOW_COOKIE}=x` }),
    );
    expect(await refusals(t)).toEqual(["flow_not_started"]);
  });

  test("a signed state for a flow that no longer exists is refused", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("oauthFlows").collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    await expectRefused(await finish(t, flow));
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
  });

  test("Google rejecting the code or verifier is refused, audited and stores nothing", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue(null);
    await expectRefused(await finish(t, await startFlow(t, householdId)));
    await expectBurnedFlowAndNothingSaved(t);
    expect(await refusals(t)).toEqual(["code_rejected"]);
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("the code, verifier, cookie and tokens never reach the logs", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    googleMocks.createSunnyCalendar.mockRejectedValue(new Error("calendar api down"));
    const flow = await startFlow(t, householdId);
    await finish(t, flow, "secret-code");
    await finish(t, { state: "x.y", cookie: null });
    const verifier = String(googleMocks.exchangeCode.mock.calls[0]![1]);
    const text = logged.map(String).join("\n");
    expect(text).toContain("calendar api down");
    for (const secret of ["secret-code", verifier, flow.secret, "refresh-new"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("reuses the existing calendar when it still exists and keeps the links", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, {
      status: "revoked",
      calendarId: "cal-old",
    });
    const eventId = await addCalendarEvent(t, householdId);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    googleMocks.calendarExists.mockResolvedValue(true);
    const res = await finish(t, await startFlow(t, householdId));
    expect(res.status).toBe(200);
    const state = await t.run(async (ctx) => ({
      connections: await ctx.db.query("calendarConnections").collect(),
      links: await ctx.db.query("calendarEventLinks").collect(),
    }));
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      externalCalendarId: "cal-old",
      status: "active",
      refreshToken: "box:refresh-new",
    });
    expect(state.connections[0]?.error).toBeUndefined();
    expect(state.links).toHaveLength(1);
    expect(googleMocks.createSunnyCalendar).not.toHaveBeenCalled();
  });

  test("creates a new calendar and drops old links when the old one is gone", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, { calendarId: "cal-old" });
    const eventId = await addCalendarEvent(t, householdId);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    googleMocks.calendarExists.mockResolvedValue(false);
    await finish(t, await startFlow(t, householdId));
    const state = await t.run(async (ctx) => ({
      connection: await ctx.db.get(connectionId),
      links: await ctx.db.query("calendarEventLinks").collect(),
    }));
    expect(state.connection?.externalCalendarId).toBe("cal-new");
    expect(state.links).toHaveLength(0);
  });

  test("reconnecting clears the cached access token", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const connectionId = await addConnection(t, householdId, { calendarId: "cal-old" });
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, { accessToken: "box:old", accessTokenExpiresAt: 99 }),
    );
    googleMocks.calendarExists.mockResolvedValue(true);
    await finish(t, await startFlow(t, householdId));
    const connection = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection?.accessToken).toBeUndefined();
    expect(connection?.accessTokenExpiresAt).toBeUndefined();
    expect(connection?.refreshToken).toBe("box:refresh-new");
  });

  test.each([
    ["a bad state", (state: string) => `/google/callback?code=c&state=bad${state}`],
    ["a missing state", () => "/google/callback?code=c"],
    ["a missing code", (state: string) => `/google/callback?state=${encodeURIComponent(state)}`],
  ])("%s answers a link expired page and saves nothing", async (_label, path) => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    await expectRefused(await t.fetch(path(flow.state), { headers: { Cookie: flow.cookie } }));
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
  });

  test("a grant without the calendar scope is refused", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    googleMocks.exchangeCode.mockResolvedValue({
      accessToken: "acc",
      refreshToken: "r",
      scopes: ["openid"],
      email: null,
    });
    const res = await finish(t, await startFlow(t, householdId));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Permission needed");
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("r");
    expect((await storedState(t)).connections).toHaveLength(0);
  });

  test("Google reporting an error answers a not connected page", async () => {
    const t = makeBackend();
    await readyHousehold(t);
    const res = await t.fetch("/google/callback?error=access_denied&state=good");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Not connected");
  });

  test("Google reporting an error leaves the flow unconsumed and unaudited", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    const res = await t.fetch(
      `/google/callback?error=access_denied&state=${encodeURIComponent(flow.state)}`,
      { headers: { Cookie: flow.cookie } },
    );
    expect(res.status).toBe(400);
    expect((await storedState(t)).flows[0]?.consumedAt).toBeUndefined();
    expect(await refusals(t)).toEqual([]);
    expect(googleMocks.exchangeCode).not.toHaveBeenCalled();
  });

  test("a failed code exchange answers a generic error page", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    googleMocks.exchangeCode.mockRejectedValue(new Error("secret detail"));
    const res = await finish(t, await startFlow(t, householdId));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Something went wrong");
    expect(body).not.toContain("secret detail");
  });

  test("a caregiver who left the household is refused", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    await addMember(t, householdId, "user_gone");
    const flow = await startFlow(t, householdId, "user_gone");
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("householdMembers").collect();
      await ctx.db.delete(rows.find((r) => r.userId === "user_gone")!._id);
    });
    const res = await finish(t, flow);
    expect(res.status).toBe(403);
    expect(googleMocks.createSunnyCalendar).not.toHaveBeenCalled();
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
  });

  test("pages and the redirect carry no-store, no-referrer and nosniff headers", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const link = await connectPath(t, householdId);
    const flow = startedFrom(await t.fetch(link));
    for (const res of [
      flow.res,
      await t.fetch(link),
      await finish(t, flow),
      await t.fetch("/google/callback?error=denied"),
    ]) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  test("a misconfiguration while verifying the state shows the generic error page", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    const flow = await startFlow(t, householdId);
    delete process.env.GOOGLE_OAUTH_STATE_SECRET;
    const res = await finish(t, flow);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Something went wrong");
    expect(body).not.toContain("GOOGLE_OAUTH_STATE_SECRET");
  });

  test("a grant that could not be saved is revoked", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    googleMocks.createSunnyCalendar.mockRejectedValue(new Error("calendar api down"));
    const res = await finish(t, await startFlow(t, householdId));
    expect(res.status).toBe(500);
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("refresh-new");
  });

  test("reconnecting with a new token revokes the old grant", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t);
    await addConnection(t, householdId, { calendarId: "cal-old" });
    googleMocks.calendarExists.mockResolvedValue(true);
    await finish(t, await startFlow(t, householdId));
    expect(await pendingScheduled(t)).toContain("googleCalendar:revokeGrant");
  });

  test("the senior's name is escaped in the success page", async () => {
    const t = makeBackend();
    const householdId = await readyHousehold(t, "Mom <script>alert(1)</script>");
    const body = await (await finish(t, await startFlow(t, householdId))).text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&#60;script&#62;");
  });
});

describe("myConnections and disconnect", () => {
  test("myConnections returns only the caller's connections without token fields", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    await addConnection(t, householdId);
    await addConnection(t, householdId, { userId: "user_b" });
    const mine = await t
      .withIdentity({ subject: "user_a" })
      .query(api.googleCalendar.myConnections, { householdId });
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]!).sort()).toEqual(
      ["accountEmail", "error", "id", "lastError", "lastSyncedAt", "status"].sort(),
    );
    expect(JSON.stringify(mine)).not.toContain("refresh-1");
  });

  test("myConnections refuses a non-member and a device", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .query(api.googleCalendar.myConnections, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
    await expect(
      t
        .withIdentity({ subject: "dev_1", sunny_kind: "device" })
        .query(api.googleCalendar.myConnections, { householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test("disconnect removes the caller's connection, links and syncs", async () => {
    const t = makeBackend();
    const { connectionId, eventId } = await setupSynced(t);
    await t.run(async (ctx) =>
      ctx.db.insert("calendarEventLinks", {
        eventId,
        connectionId,
        externalEventId: "gx",
        syncedAt: 1,
      }),
    );
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.googleCalendar.disconnect, { connectionId });
    const left = await t.run(async (ctx) => ({
      connections: await ctx.db.query("calendarConnections").collect(),
      links: await ctx.db.query("calendarEventLinks").collect(),
      syncs: await ctx.db.query("calendarSyncs").collect(),
    }));
    expect(left.connections).toHaveLength(0);
    expect(left.links).toHaveLength(0);
    expect(left.syncs).toHaveLength(0);
  });

  test("disconnect refuses someone else's connection and a signed-out caller", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMember(t, householdId, "user_b");
    const bConnection = await addConnection(t, householdId, { userId: "user_b" });
    await expect(
      t.withIdentity({ subject: "user_a" }).mutation(api.googleCalendar.disconnect, {
        connectionId: bConnection,
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
    await expect(
      t.mutation(api.googleCalendar.disconnect, { connectionId: bConnection }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    expect(
      await t.run(async (ctx) => await ctx.db.query("calendarConnections").collect()),
    ).toHaveLength(1);
  });
});

describe("OAuth flow housekeeping and grant revocation", () => {
  test("the sweeper deletes only expired flows", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await connectPath(t, householdId);
    vi.advanceTimersByTime(6 * 60_000);
    await startFlow(t, householdId);
    expect(await t.mutation(internal.googleCalendar.sweepOauthFlows, {})).toBe(1);
    const left = (await storedState(t)).flows;
    expect(left).toHaveLength(1);
    expect(left[0]?.started).toBeDefined();
  });

  test("revokeGrant decrypts the stored token and revokes it at Google", async () => {
    const t = makeBackend();
    expect(await t.action(internal.googleCalendar.revokeGrant, { refreshToken: "box:rt-1" })).toBe(
      true,
    );
    expect(googleMocks.revokeRefreshToken).toHaveBeenCalledWith("rt-1");
  });

  test("revokeGrant never throws when the token cannot be read", async () => {
    const t = makeBackend();
    expect(await t.action(internal.googleCalendar.revokeGrant, { refreshToken: "garbage" })).toBe(
      false,
    );
    expect(googleMocks.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("disconnect schedules the grant revocation", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.googleCalendar.disconnect, { connectionId });
    expect(await pendingScheduled(t)).toContain("googleCalendar:revokeGrant");
  });

  test("myConnections shows the sync error", async () => {
    const t = makeBackend();
    const { householdId, connectionId } = await setupSynced(t);
    await t.run(async (ctx) => ctx.db.patch(connectionId, { lastError: "Some events failed" }));
    const mine = await t
      .withIdentity({ subject: "user_a" })
      .query(api.googleCalendar.myConnections, { householdId });
    expect(mine[0]?.lastError).toBe("Some events failed");
  });
});
