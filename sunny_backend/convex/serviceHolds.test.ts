import type { WorkId } from "@convex-dev/workpool";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { gmailMocks, googleMocks } from "./googleMocks.helpers";
import { ConfigError } from "./lib/errors";
import { GoogleAccessRevoked, GoogleApiError } from "./lib/google";
import type { HoldService } from "./lib/serviceHolds";
import {
  item,
  jevCalls,
  jevSays,
  mailHousehold,
  rawEmail,
  receive,
  rows,
} from "./mailMocks.helpers";
import type { MailHousehold } from "./mailMocks.helpers";
import { NOW } from "./lib/mailFixtures.helpers";
import { MINUTE_MS } from "./lib/time";
import {
  PHISHING,
  clinic,
  poolFinishesEveryJob,
  reconnectAs,
  useTriageClock,
} from "./mailTriage.helpers";
import { MAX_TRIAGE_ATTEMPTS } from "./mailTriage";
import { MAIL_HELD_NOTE } from "./serviceHolds";
import {
  createHousehold,
  makeBackend,
  pendingScheduled,
  setupSynced,
  syncRows,
} from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

vi.mock("./lib/google", async (original) =>
  (await import("./googleMocks.helpers")).googleMock(await original()),
);
vi.mock("./lib/gmailApi", async (original) =>
  (await import("./googleMocks.helpers")).gmailMock(await original()),
);
vi.mock("./lib/googleEvent", async () => (await import("./googleMocks.helpers")).googleEventMock);
vi.mock("./lib/secretBox", async (original) =>
  (await import("./googleMocks.helpers")).secretBoxMock(await original()),
);

useTriageClock();

const QUOTA = '{"error":{"code":403,"errors":[{"reason":"dailyLimitExceeded"}]}}';
const NOTE_FAN_OUT = "serviceHolds:noteMailHeld";

async function holds(t: TestConvex): Promise<Doc<"serviceHolds">[]> {
  return await t.run(async (ctx) => await ctx.db.query("serviceHolds").collect());
}

async function holdOpen(t: TestConvex, service: HoldService): Promise<boolean> {
  return (await holds(t)).some((hold) => hold.service === service && hold.open);
}

async function openHold(t: TestConvex, service: HoldService, since = NOW): Promise<boolean> {
  return await t.mutation(internal.serviceHolds.open, { service, error: "down", since });
}

async function noteFanOuts(t: TestConvex): Promise<number> {
  return (await pendingScheduled(t)).filter((name) => name === NOTE_FAN_OUT).length;
}

async function runNoteFanOut(t: TestConvex): Promise<void> {
  await t.mutation(internal.serviceHolds.noteMailHeld, { cursor: null });
}

async function heldNotes(t: TestConvex): Promise<Id<"households">[]> {
  const posts = await t.run(async (ctx) => await ctx.db.query("chatPosts").collect());
  return posts.filter((p) => p.body === MAIL_HELD_NOTE).map((p) => p.householdId);
}

async function addMailbox(
  t: TestConvex,
  householdId: Id<"households">,
  status: Doc<"mailboxes">["status"],
): Promise<Id<"mailboxes">> {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("mailboxes", {
        householdId,
        connectedBy: "user_a",
        accountEmail: `${householdId}@example.com`,
        refreshToken: "box:refresh-1",
        status,
        historyId: "100",
      }),
  );
}

async function sweepMail(h: MailHousehold): Promise<number> {
  return await h.t.mutation(internal.mailTriage.sweepStuck, {});
}

async function triage(h: MailHousehold, itemId: Id<"mailItems">): Promise<string> {
  return await h.t.action(internal.mailTriage.triage, { itemId });
}

describe("opening a hold", () => {
  test("posts the held note once to each household with an active mailbox, and no push", async () => {
    const t = makeBackend();
    const reading = await createHousehold(t, { subject: "a" });
    const alsoReading = await createHousehold(t, { subject: "b" });
    const revoked = await createHousehold(t, { subject: "c" });
    await createHousehold(t, { subject: "d" });
    await addMailbox(t, reading, "active");
    await addMailbox(t, alsoReading, "active");
    await addMailbox(t, revoked, "revoked");

    expect(await openHold(t, "gmail")).toBe(true);
    expect(await noteFanOuts(t)).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await heldNotes(t)).sort()).toEqual([reading, alsoReading].sort());
    const posts = await t.run(async (ctx) => await ctx.db.query("chatPosts").collect());
    expect(posts.map((p) => p.kind)).toEqual(["mailbox", "mailbox"]);
    expect(await t.run(async (ctx) => await ctx.db.query("notificationOutbox").collect())).toEqual(
      [],
    );
  });

  test("many jobs failing at once open one hold and post one note per household", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId, "active");
    const opened = await Promise.all(
      Array.from({ length: 6 }, (_, i) => openHold(t, "gmail", NOW - i * MINUTE_MS)),
    );
    expect(opened.filter(Boolean)).toHaveLength(1);
    expect(await holds(t)).toHaveLength(1);
    expect(await noteFanOuts(t)).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await heldNotes(t)).toEqual([householdId]);
  });

  test("a second mail hold while mail is already held adds no note, and a calendar hold never posts", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId, "active");
    await openHold(t, "calendar");
    expect(await noteFanOuts(t)).toBe(0);
    await openHold(t, "jev");
    await openHold(t, "gmail");
    expect(await noteFanOuts(t)).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await heldNotes(t)).toEqual([householdId]);
  });

  test("the note goes out again only after the hold closes and a new one opens", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId, "active");
    await openHold(t, "jev");
    expect(await openHold(t, "jev")).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await heldNotes(t)).toHaveLength(1);

    vi.setSystemTime(NOW + 20 * MINUTE_MS);
    await t.mutation(internal.serviceHolds.close, { services: ["jev"], since: NOW + MINUTE_MS });
    vi.setSystemTime(NOW + 30 * MINUTE_MS);
    expect(await openHold(t, "jev", NOW + 25 * MINUTE_MS)).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await heldNotes(t)).toEqual([householdId, householdId]);
  });

  test("a fan-out that runs after the hold closed posts nothing", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await addMailbox(t, householdId, "active");
    await openHold(t, "gmail");
    await t.mutation(internal.serviceHolds.close, { services: ["gmail"], since: NOW + 1 });
    await runNoteFanOut(t);
    expect(await heldNotes(t)).toEqual([]);
  });

  test("a paused household gets no held note", async () => {
    const t = makeBackend();
    const reading = await createHousehold(t, { subject: "a" });
    const paused = await createHousehold(t, { subject: "b" });
    await addMailbox(t, reading, "active");
    await addMailbox(t, paused, "active");
    await t.run(async (ctx) => await ctx.db.patch(paused, { backgroundPaused: true }));
    await openHold(t, "jev");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await heldNotes(t)).toEqual([reading]);
  });
});

describe("connecting a mailbox while mail is held", () => {
  test.each(["gmail", "jev"] as const)(
    "posts the held note once when a %s hold is open",
    async (service) => {
      const h = await mailHousehold(makeBackend());
      await openHold(h.t, service);
      await h.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await heldNotes(h.t)).toEqual([h.householdId]);
      await reconnectAs(h, "new@example.com");
      expect(await heldNotes(h.t)).toEqual([h.householdId, h.householdId]);
    },
  );

  test("posts no held note while mail is read, under a calendar hold, or for a paused household", async () => {
    const h = await mailHousehold(makeBackend());
    await reconnectAs(h, "new@example.com");
    await openHold(h.t, "calendar");
    await reconnectAs(h, "newer@example.com");
    expect(await heldNotes(h.t)).toEqual([]);

    await h.t.run(async (ctx) => await ctx.db.patch(h.householdId, { backgroundPaused: true }));
    await openHold(h.t, "gmail");
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    await reconnectAs(h, "newest@example.com");
    expect(await heldNotes(h.t)).toEqual([]);
  });
});

describe("fencing", () => {
  test("a failure from a job that started before the hold closed does not reopen it", async () => {
    const t = makeBackend();
    await openHold(t, "gmail", NOW);
    vi.setSystemTime(NOW + 20 * MINUTE_MS);
    await t.mutation(internal.serviceHolds.close, {
      services: ["gmail"],
      since: NOW + 16 * MINUTE_MS,
    });
    vi.setSystemTime(NOW + 21 * MINUTE_MS);
    expect(await openHold(t, "gmail", NOW + 18 * MINUTE_MS)).toBe(false);
    expect(await openHold(t, "gmail", NOW + 20 * MINUTE_MS)).toBe(false);
    expect(await holdOpen(t, "gmail")).toBe(false);
    expect(await openHold(t, "gmail", NOW + 21 * MINUTE_MS)).toBe(true);
    expect(await holdOpen(t, "gmail")).toBe(true);
  });

  test("a probe re-arms only a hold that was open when it started", async () => {
    const t = makeBackend();
    vi.setSystemTime(NOW + 20 * MINUTE_MS);
    await openHold(t, "jev", NOW + 19 * MINUTE_MS);
    const probeAgain = (since: number) =>
      t.mutation(internal.mailTriage.probeAgain, { services: ["jev"], since });
    expect(await probeAgain(NOW + 10 * MINUTE_MS)).toEqual([]);
    expect((await holds(t))[0]).toMatchObject({ probeAt: NOW + 35 * MINUTE_MS });
    vi.setSystemTime(NOW + 21 * MINUTE_MS);
    expect(await probeAgain(NOW + 20 * MINUTE_MS)).toEqual(["jev"]);
    expect((await holds(t))[0]).toMatchObject({ probeAt: NOW + 21 * MINUTE_MS });
  });

  test("a success from a job that started before the hold's failing call does not close it", async () => {
    const t = makeBackend();
    await openHold(t, "calendar", NOW);
    vi.setSystemTime(NOW + 20 * MINUTE_MS);
    expect(
      await t.mutation(internal.serviceHolds.close, { services: ["calendar"], since: NOW }),
    ).toEqual([]);
    expect(await holdOpen(t, "calendar")).toBe(true);
    expect(
      await t.mutation(internal.serviceHolds.close, { services: ["calendar"], since: NOW + 1 }),
    ).toEqual(["calendar"]);
  });
});

describe("mail while a hold is open", () => {
  test.each(["gmail", "jev"] as const)(
    "a %s hold stops claims without spending an attempt, and the sweeper enqueues nothing",
    async (service) => {
      const h = await mailHousehold(makeBackend());
      poolFinishesEveryJob();
      jevSays(PHISHING);
      const itemId = await receive(h, clinic());
      await openHold(h.t, service);
      expect(await triage(h, itemId)).toBe("skipped");
      expect(console.log).toHaveBeenCalledWith("Mail triage skipped: mail held");
      expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 0 });
      expect(gmailMocks.getMessage).not.toHaveBeenCalled();
      vi.setSystemTime(NOW + 14 * MINUTE_MS + 59_000);
      expect(await sweepMail(h)).toBe(0);
    },
  );

  test("a Gmail hold stops polls, and a calendar hold stops neither polls nor claims", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    await openHold(h.t, "calendar");
    expect(await h.t.mutation(internal.gmail.pollAll, {})).toBe(1);
    jevSays(PHISHING);
    const itemId = await receive(h, clinic());
    expect(await triage(h, itemId)).toBe("applied");

    await openHold(h.t, "gmail");
    expect(await h.t.mutation(internal.gmail.pollAll, {})).toBe(0);
    expect(await h.t.action(internal.gmail.poll, { mailboxId: h.mailboxId })).toBe("skipped");
    expect(console.log).toHaveBeenCalledWith("Gmail poll skipped: Gmail held");
    expect(gmailMocks.listHistory).not.toHaveBeenCalled();
  });

  test("one claim probes after 15 minutes; its success closes the hold and the sweeper resumes the rest", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    jevSays(PHISHING);
    const first = await receive(h, clinic());
    const second = await receive(h, clinic());
    await openHold(h.t, "jev");

    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await sweepMail(h)).toBe(1);
    expect(await triage(h, first)).toBe("applied");
    expect(await holdOpen(h.t, "jev")).toBe(false);
    expect(await item(h, second)).toMatchObject({ state: "queued", attempt: 0 });

    vi.setSystemTime(NOW + 32 * MINUTE_MS);
    expect(await sweepMail(h)).toBe(1);
    expect(await triage(h, second)).toBe("applied");
  });

  test("a probe that fails on the hold keeps it open, spends no attempt and waits 15 minutes for the next", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    jevSays({ status: 401 });
    const first = await receive(h, clinic());
    const second = await receive(h, clinic());
    await openHold(h.t, "jev");

    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await triage(h, first)).toBe("held");
    expect(await item(h, first)).toMatchObject({ state: "queued", attempt: 1, heldClaims: 1 });
    expect(await triage(h, second)).toBe("skipped");
    expect(await item(h, second)).toMatchObject({ state: "queued", attempt: 0 });
    expect(await holdOpen(h.t, "jev")).toBe(true);

    vi.setSystemTime(NOW + 31 * MINUTE_MS);
    jevSays(PHISHING);
    expect(await triage(h, second)).toBe("applied");
    expect(await holdOpen(h.t, "jev")).toBe(false);
  });

  test("gate-settled probes re-arm the Jev probe and start the next item, so Jev is probed in the same window", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    jevSays(PHISHING);
    const emails = [
      clinic({ labels: ["SPAM"] }),
      clinic({ labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
      clinic(),
    ];
    const items: Id<"mailItems">[] = [];
    for (const [i, email] of emails.entries()) {
      vi.setSystemTime(NOW + i * 1000);
      items.push(await receive(h, email));
    }
    gmailMocks.getMessage.mockImplementation(async (_token: string, id: string) =>
      rawEmail(emails.find((email) => email.id === id)!),
    );
    await openHold(h.t, "jev");

    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await sweepMail(h)).toBe(1);
    const [spam, promotion, appointment] = items as [
      Id<"mailItems">,
      Id<"mailItems">,
      Id<"mailItems">,
    ];
    for (const [probe, next] of [
      [spam, promotion],
      [promotion, appointment],
    ] as const) {
      const queuedJob = (await item(h, next)).jobId;
      expect(await triage(h, probe)).toBe("applied");
      expect(await holdOpen(h.t, "jev")).toBe(true);
      expect((await item(h, next)).jobId).not.toBe(queuedJob);
    }
    expect(jevCalls).toHaveLength(0);
    expect(await triage(h, appointment)).toBe("applied");
    expect(jevCalls).toHaveLength(1);
    expect(await holdOpen(h.t, "jev")).toBe(false);
  });

  test("the probe sweep fails orphan rows quietly and spends its one enqueue on a real row", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    const orphan = await h.t.run(
      async (ctx) =>
        await ctx.db.insert("mailItems", {
          householdId: h.householdId,
          account: "old@example.com",
          gmailId: "old-1",
          state: "queued",
          attempt: 0,
          leaseUntil: NOW,
        }),
    );
    vi.setSystemTime(NOW + 1000);
    const real = await receive(h, clinic());
    const realJob = (await item(h, real)).jobId;
    await openHold(h.t, "jev");

    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await sweepMail(h)).toBe(1);
    expect(await item(h, orphan)).toMatchObject({ state: "failed" });
    expect((await item(h, real)).jobId).not.toBe(realJob);
    expect(await rows(h, "chatPosts")).toEqual([]);
  });

  test("a probe that Jev answers with a server error spends no attempt while the hold stays open", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const h = await mailHousehold(makeBackend());
    jevSays({ status: 503 });
    const itemId = await receive(h, clinic());
    await openHold(h.t, "jev");
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    await expect(triage(h, itemId)).rejects.toThrow();
    expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 1, heldClaims: 1 });
    expect(await holdOpen(h.t, "jev")).toBe(true);
  });

  test("a probe that Gmail answers with a server error spends no attempt while the Gmail hold stays open", async () => {
    const h = await mailHousehold(makeBackend());
    const itemId = await receive(h, clinic());
    gmailMocks.getMessage.mockRejectedValue(new GoogleApiError(503, "Service Unavailable"));
    await openHold(h.t, "gmail");
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    await expect(triage(h, itemId)).rejects.toThrow();
    expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 1, heldClaims: 1 });
    expect(await holdOpen(h.t, "gmail")).toBe(true);
  });

  test("a probe that loses the mailbox spends an attempt while the hold stays open", async () => {
    const h = await mailHousehold(makeBackend());
    const itemId = await receive(h, clinic());
    gmailMocks.getMessage.mockRejectedValue(
      new GoogleApiError(403, '{"error":{"code":403,"errors":[{"reason":"forbidden"}]}}'),
    );
    await openHold(h.t, "gmail");
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await triage(h, itemId)).toBe("mailbox_lost");
    const row = await item(h, itemId);
    expect(row).toMatchObject({ state: "queued", attempt: 1 });
    expect(row.heldClaims).toBeUndefined();
    expect(await holdOpen(h.t, "gmail")).toBe(true);
  });

  test("a probe row that fails for its own reason reaches the attempt cap while the hold stays open and the other row keeps probing", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    jevSays({ status: 401 });
    const poisonEmail = clinic();
    const otherEmail = clinic();
    const poison = await receive(h, poisonEmail);
    vi.setSystemTime(NOW + 1000);
    const other = await receive(h, otherEmail);
    gmailMocks.getMessage.mockImplementation(async (_token: string, id: string) => {
      if (id === poisonEmail.id) throw new GoogleApiError(500, "Backend Error");
      return rawEmail(otherEmail);
    });
    await openHold(h.t, "jev");

    for (let window = 1; window <= 30; window += 1) {
      if ((await item(h, poison)).state === "failed") break;
      vi.setSystemTime(NOW + window * 16 * MINUTE_MS);
      const jobs = [(await item(h, poison)).jobId, (await item(h, other)).jobId];
      expect(await sweepMail(h)).toBe(1);
      vi.setSystemTime(NOW + window * 16 * MINUTE_MS + 1000);
      for (const [i, itemId] of [poison, other].entries()) {
        if ((await item(h, itemId)).jobId === jobs[i]) continue;
        await triage(h, itemId).catch(() => "retried");
      }
    }

    const failed = await item(h, poison);
    expect(failed).toMatchObject({ state: "failed", attempt: MAX_TRIAGE_ATTEMPTS });
    expect(failed.heldClaims).toBeUndefined();
    const probed = await item(h, other);
    expect(probed.state).toBe("queued");
    expect(probed.attempt).toBeGreaterThanOrEqual(MAX_TRIAGE_ATTEMPTS - 1);
    expect(probed.heldClaims).toBe(probed.attempt);
    expect(await holdOpen(h.t, "jev")).toBe(true);
    expect((await rows(h, "chatPosts")).map((p) => p.body)).toContain(
      "Sunny could not read an email. Please look at the inbox in Gmail.",
    );
  });

  test("a probe that never reaches Jev closes the Gmail hold and leaves the Jev hold open", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    const itemId = await receive(h, clinic());
    gmailMocks.getMessage.mockResolvedValue(null);
    await openHold(h.t, "gmail");
    await openHold(h.t, "jev");
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await triage(h, itemId)).toBe("gone");
    expect(await holdOpen(h.t, "gmail")).toBe(false);
    expect(await holdOpen(h.t, "jev")).toBe(true);
  });

  test("a poll probes once per 15 minutes and its success lets every mailbox poll again", async () => {
    const h = await mailHousehold(makeBackend());
    poolFinishesEveryJob();
    const other = await createHousehold(h.t, { subject: "other" });
    const otherMailbox = await addMailbox(h.t, other, "active");
    await openHold(h.t, "gmail");

    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.mutation(internal.gmail.pollAll, {})).toBe(1);
    expect(await h.t.action(internal.gmail.poll, { mailboxId: otherMailbox })).toBe("polled");
    expect(await holdOpen(h.t, "gmail")).toBe(false);
    expect(await h.t.mutation(internal.gmail.pollAll, {})).toBe(2);
  });

  test("a failed poll probe keeps the hold, and a later poll before the next probe is skipped", async () => {
    const h = await mailHousehold(makeBackend());
    await openHold(h.t, "gmail");
    gmailMocks.listHistory.mockRejectedValue(new GoogleApiError(403, QUOTA));
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.action(internal.gmail.poll, { mailboxId: h.mailboxId })).toBe("held");
    expect(await h.t.action(internal.gmail.poll, { mailboxId: h.mailboxId })).toBe("skipped");
    expect(gmailMocks.listHistory).toHaveBeenCalledTimes(1);
    expect(await holdOpen(h.t, "gmail")).toBe(true);
    expect((await holds(h.t))[0]).toMatchObject({ probeAt: NOW + 31 * MINUTE_MS });
  });
});

describe("what opens a hold", () => {
  test("a missing TypeSafe key holds Jev, and Gmail stays open", async () => {
    const h = await mailHousehold(makeBackend());
    const itemId = await receive(h, clinic());
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await triage(h, itemId)).toBe("held");
    expect(await holds(h.t)).toEqual([
      expect.objectContaining({
        service: "jev",
        open: true,
        error: "Missing env var TYPESAFE_API_KEY",
      }),
    ]);
    expect(await noteFanOuts(h.t)).toBe(1);
  });

  test("a missing Google setting raised in triage holds Gmail", async () => {
    const h = await mailHousehold(makeBackend());
    const itemId = await receive(h, clinic());
    googleMocks.refreshAccessToken.mockRejectedValue(
      new ConfigError("Missing env var GOOGLE_CLIENT_ID"),
    );
    expect(await triage(h, itemId)).toBe("held");
    expect(await holds(h.t)).toEqual([expect.objectContaining({ service: "gmail", open: true })]);
  });

  test("several triage jobs failing at once open one hold", async () => {
    const h = await mailHousehold(makeBackend());
    jevSays({ status: 403 });
    const items = [
      await receive(h, clinic()),
      await receive(h, clinic()),
      await receive(h, clinic()),
    ];
    const outcomes = await Promise.all(items.map((itemId) => triage(h, itemId)));
    expect(outcomes.filter((o) => o === "held").length).toBeGreaterThanOrEqual(1);
    expect(await holds(h.t)).toEqual([expect.objectContaining({ service: "jev", open: true })]);
    expect(await noteFanOuts(h.t)).toBe(1);
    await h.t.mutation(internal.serviceHolds.noteMailHeld, { cursor: null });
    expect(await heldNotes(h.t)).toEqual([h.householdId]);
    expect(await rows(h, "notificationOutbox")).toEqual([]);
  });
});

describe("calendar pushes while a hold is open", () => {
  const WORK_ID = "work_1" as WorkId;

  async function push(t: TestConvex): Promise<string> {
    const [row] = await syncRows(t);
    return await t.action(internal.calendarPush.push, { syncId: row!._id });
  }

  test("a quota error holds the calendar; later pushes wait without calling Google or touching the row", async () => {
    const t = makeBackend();
    const { connectionId } = await setupSynced(t);
    googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(403, QUOTA));
    expect(await push(t)).toBe("held");
    expect(await holds(t)).toEqual([expect.objectContaining({ service: "calendar", open: true })]);
    expect(await noteFanOuts(t)).toBe(0);
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("calendarSyncs").collect();
      await ctx.db.patch(row!._id, { state: "queued", updatedAt: NOW - 20 * MINUTE_MS });
    });

    expect(await push(t)).toBe("waiting");
    expect(googleMocks.upsertEvent).toHaveBeenCalledTimes(1);
    const [row] = await syncRows(t);
    expect(row).toMatchObject({ state: "queued", updatedAt: NOW - 20 * MINUTE_MS });
    await t.mutation(internal.calendarPush.onPushComplete, {
      workId: WORK_ID,
      context: { syncId: row!._id },
      result: { kind: "success", returnValue: "waiting" },
    });
    expect(await syncRows(t)).toEqual([row]);
    expect(await t.mutation(internal.calendarFanOut.sweepStuckSyncs, {})).toBe(0);
    const connection = await t.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection).toMatchObject({ status: "active" });
    expect(connection?.lastError).toBeUndefined();
    expect(await t.run(async (ctx) => await ctx.db.query("chatPosts").collect())).toEqual([]);
  });

  test("the sweeper sends one probe after 15 minutes and its success resumes pushes", async () => {
    const t = makeBackend();
    const { householdId } = await setupSynced(t);
    await t.withIdentity({ subject: "user_a" }).mutation(api.calendar.addEvent, {
      householdId,
      title: "Dentist again",
      onDate: "2099-06-02",
      startTime: "10:00",
    });
    await openHold(t, "calendar");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("calendarSyncs").collect()) {
        await ctx.db.patch(row._id, { updatedAt: NOW - 20 * MINUTE_MS });
      }
    });
    expect(await t.mutation(internal.calendarFanOut.sweepStuckSyncs, {})).toBe(0);

    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await t.mutation(internal.calendarFanOut.sweepStuckSyncs, {})).toBe(1);
    expect(await push(t)).toBe("created");
    expect(await holdOpen(t, "calendar")).toBe(false);
    expect(await t.mutation(internal.calendarFanOut.sweepStuckSyncs, {})).toBe(1);
  });

  test.each([
    {
      answer: "an event Google no longer has, in a calendar it still has",
      calendarFound: true,
      outcome: "failed",
    },
    {
      answer: "an event Google no longer has, in a calendar it deleted",
      calendarFound: false,
      outcome: "calendar_missing",
    },
    { answer: "a permanent error", calendarFound: null, outcome: "failed" },
    {
      answer: "a forbidden calendar",
      calendarFound: null,
      outcome: "failed",
      status: 403,
    },
  ])(
    "a probe that Google answers with $answer closes the hold and keeps its outcome",
    async ({ calendarFound, outcome, status }) => {
      const t = makeBackend();
      await setupSynced(t);
      await openHold(t, "calendar");
      if (calendarFound === null) {
        googleMocks.upsertEvent.mockRejectedValue(
          new GoogleApiError(status ?? 400, '{"error":{"message":"refused"}}'),
        );
      } else {
        googleMocks.upsertEvent.mockRejectedValue(new GoogleApiError(404, "Not Found"));
        googleMocks.calendarExists.mockResolvedValue(calendarFound);
      }
      vi.setSystemTime(NOW + 16 * MINUTE_MS);
      expect(await push(t)).toBe(outcome);
      expect(await holdOpen(t, "calendar")).toBe(false);
    },
  );

  test("a probe whose sign-in Google revoked does not close the hold", async () => {
    const t = makeBackend();
    await setupSynced(t);
    await openHold(t, "calendar");
    googleMocks.refreshAccessToken.mockRejectedValue(new GoogleAccessRevoked("invalid_grant"));
    await t.run(async (ctx) => {
      for (const connection of await ctx.db.query("calendarConnections").collect()) {
        await ctx.db.patch(connection._id, { accessToken: undefined });
      }
    });
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await push(t)).toBe("revoked");
    expect(await holdOpen(t, "calendar")).toBe(true);
  });

  test("Gmail and Jev holds do not hold pushes", async () => {
    const t = makeBackend();
    await setupSynced(t);
    await openHold(t, "gmail");
    await openHold(t, "jev");
    expect(await push(t)).toBe("created");
  });
});
