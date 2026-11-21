import type { WorkId } from "@convex-dev/workpool";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { gmailMocks, googleMocks } from "./googleMocks.helpers";
import { GoogleAccessRevoked, GoogleApiError } from "./lib/google";
import { mailPool } from "./lib/mailPool";
import {
  MAILBOX,
  item,
  jevRepliesWith,
  jevSays,
  rawEmail,
  receive,
  rows,
} from "./mailMocks.helpers";
import type { JevWireReply, MailHousehold } from "./mailMocks.helpers";
import { MAX_TRIAGE_ATTEMPTS } from "./mailTriage";
import { EYE_EXAM, NOW } from "./lib/mailFixtures.helpers";
import { MINUTE_MS } from "./lib/time";
import {
  PHISHING,
  clinic,
  poolFinishesEveryJob,
  reconnectAs,
  setup,
  threadAsPat,
  useTriageClock,
} from "./mailTriage.helpers";

vi.mock("./lib/google", async (original) =>
  (await import("./googleMocks.helpers")).googleMock(await original()),
);
vi.mock("./lib/gmailApi", async (original) =>
  (await import("./googleMocks.helpers")).gmailMock(await original()),
);
vi.mock("./lib/secretBox", async (original) =>
  (await import("./googleMocks.helpers")).secretBoxMock(await original()),
);

useTriageClock();

async function openHolds(h: MailHousehold): Promise<string[]> {
  const holds = await h.t.run(async (ctx) => await ctx.db.query("serviceHolds").collect());
  return holds.filter((hold) => hold.open).map((hold) => hold.service);
}

describe("the item lifecycle", () => {
  test("a paused household is not claimed and resumes through sweepStuck", async () => {
    const h = await setup();
    poolFinishesEveryJob();
    jevSays(PHISHING);
    await h.t.run(async (ctx) => ctx.db.patch(h.householdId, { backgroundPaused: true }));
    const itemId = await receive(h, clinic());
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("skipped");
    expect(console.log).toHaveBeenCalledWith("Mail triage skipped: household paused");
    expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 0 });

    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(0);

    await h.t.run(async (ctx) => ctx.db.patch(h.householdId, { backgroundPaused: false }));
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(0);
    vi.setSystemTime(NOW + 32 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(1);
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("applied");
    expect((await item(h, itemId)).state).toBe("done");
  });

  test("a row waits while the mailbox is revoked and is triaged after a reconnect to the same address", async () => {
    const h = await setup();
    poolFinishesEveryJob();
    jevSays(PHISHING);
    const itemId = await receive(h, clinic());
    for (const status of ["revoked", "error"] as const) {
      await h.t.run(async (ctx) => ctx.db.patch(h.mailboxId, { status }));
      expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("skipped");
      expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 0 });
    }
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(0);

    await h.t.run(async (ctx) => ctx.db.patch(h.mailboxId, { status: "active" }));
    vi.setSystemTime(NOW + 32 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(1);
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("applied");
    expect((await item(h, itemId)).state).toBe("done");
  });

  test("the sweeper fails a row whose mailbox is gone quietly, without enqueuing it", async () => {
    const h = await setup();
    poolFinishesEveryJob();
    const itemId = await receive(h, clinic());
    await h.t.run(async (ctx) => ctx.db.delete(h.mailboxId));
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(0);
    expect((await item(h, itemId)).state).toBe("failed");
    expect(await rows(h, "chatPosts")).toHaveLength(0);
  });

  test("a row for a disconnected mailbox fails quietly", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    await h.t.run(async (ctx) => ctx.db.delete(h.mailboxId));
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("skipped");
    expect((await item(h, itemId)).state).toBe("failed");
    expect(await rows(h, "chatPosts")).toHaveLength(0);
    expect(gmailMocks.getMessage).not.toHaveBeenCalled();
  });

  test("a row from another account than the mailbox's fails quietly", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    await h.t.run(async (ctx) => ctx.db.patch(h.mailboxId, { accountEmail: "other@example.com" }));
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("skipped");
    expect((await item(h, itemId)).state).toBe("failed");
  });

  test("a Jev server error releases the claim and rethrows, keeping the headers", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const h = await setup();
    jevSays({ status: 503 });
    const itemId = await receive(h, clinic());
    await expect(h.t.action(internal.mailTriage.triage, { itemId })).rejects.toThrow();
    expect(await item(h, itemId)).toMatchObject({
      state: "queued",
      attempt: 1,
      subject: "Your appointment is confirmed",
    });
    expect((await item(h, itemId)).heldClaims).toBeUndefined();
  });

  test("a Jev 422 is not retried", async () => {
    const h = await setup();
    jevSays({ status: 422 });
    const itemId = await receive(h, clinic());
    await expect(h.t.action(internal.mailTriage.triage, { itemId })).rejects.toMatchObject({
      name: "NonRetryableError",
    });
  });

  test.each([401, 403])(
    "a Jev %i holds Jev and the row without spending an attempt or posting about the email",
    async (status) => {
      const h = await setup();
      jevSays({ status });
      const itemId = await receive(h, clinic());
      expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("held");
      expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 1, heldClaims: 1 });
      expect(await openHolds(h)).toEqual(["jev"]);
      expect(await rows(h, "chatPosts")).toHaveLength(0);
      expect(await rows(h, "events")).toHaveLength(0);
    },
  );

  test("a Google project quota holds Gmail and the row and leaves the mailbox active without a grant notice", async () => {
    const h = await setup();
    poolFinishesEveryJob();
    const itemId = await receive(h, clinic());
    gmailMocks.getMessage.mockRejectedValue(
      new GoogleApiError(
        403,
        '{"error":{"code":403,"errors":[{"domain":"usageLimits","reason":"dailyLimitExceeded"}]}}',
      ),
    );
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("held");
    expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 1, heldClaims: 1 });
    expect(await openHolds(h)).toEqual(["gmail"]);
    const mailbox = await h.t.run(async (ctx) => await ctx.db.get(h.mailboxId));
    expect(mailbox).toMatchObject({ status: "active" });
    expect(await rows(h, "chatPosts")).toHaveLength(0);
    expect(await rows(h, "notificationOutbox")).toHaveLength(0);
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(1);
  });

  test("held claims are left out of the attempt cap and the claims around them count", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    const claimAndRelease = async (held: boolean): Promise<string> => {
      const claim = await h.t.mutation(internal.mailTriage.claimItem, { itemId });
      if (claim.kind === "claimed") {
        await h.t.mutation(internal.mailTriage.releaseClaim, {
          itemId,
          attempt: claim.attempt,
          held,
          unavailable: null,
        });
      }
      return claim.kind;
    };
    for (let round = 0; round < MAX_TRIAGE_ATTEMPTS - 1; round += 1) {
      expect(await claimAndRelease(false)).toBe("claimed");
    }
    for (let round = 0; round < 3; round += 1) {
      expect(await claimAndRelease(true)).toBe("claimed");
    }
    expect(await claimAndRelease(false)).toBe("claimed");
    expect(await claimAndRelease(false)).toBe("skip");
    expect(await item(h, itemId)).toMatchObject({
      state: "failed",
      attempt: MAX_TRIAGE_ATTEMPTS + 3,
      heldClaims: 3,
    });
  });

  test("a held release from a lapsed claim changes nothing", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    expect(await h.t.mutation(internal.mailTriage.claimItem, { itemId })).toMatchObject({
      attempt: 1,
    });
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    await h.t.mutation(internal.mailTriage.sweepStuck, {});
    expect(await h.t.mutation(internal.mailTriage.claimItem, { itemId })).toMatchObject({
      attempt: 2,
    });
    await h.t.mutation(internal.mailTriage.releaseClaim, {
      itemId,
      attempt: 1,
      held: true,
      unavailable: null,
    });
    const row = await item(h, itemId);
    expect(row).toMatchObject({ state: "triaging", attempt: 2 });
    expect(row.heldClaims).toBeUndefined();
  });

  test("a row probed for a missing TypeSafe key outlasts the attempt cap and is triaged once the key is set", async () => {
    const h = await setup();
    poolFinishesEveryJob();
    const itemId = await receive(h, clinic());
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    let now = NOW;
    for (let round = 0; round < MAX_TRIAGE_ATTEMPTS + 2; round += 1) {
      expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("held");
      expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("skipped");
      now += 16 * MINUTE_MS;
      vi.setSystemTime(now);
      expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(1);
    }
    expect(await item(h, itemId)).toMatchObject({
      state: "queued",
      attempt: MAX_TRIAGE_ATTEMPTS + 2,
      heldClaims: MAX_TRIAGE_ATTEMPTS + 2,
    });
    expect(await rows(h, "chatPosts")).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    jevSays(PHISHING);
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("applied");
    expect((await item(h, itemId)).state).toBe("done");
    expect(await openHolds(h)).toEqual([]);
  });

  test.each([
    [
      "a Noul above 1",
      (r: JevWireReply) => ({
        ...r,
        answers: { ...r.answers, addresses_assistant: { type: "noul", noul: 1.4 } },
      }),
    ],
    [
      "a negative Noul",
      (r: JevWireReply) => ({
        ...r,
        answers: { ...r.answers, asks_private_details: { type: "noul", noul: -0.4 } },
      }),
    ],
    [
      "a chosen option with a probability above 1",
      (r: JevWireReply) => ({
        ...r,
        answers: {
          ...r.answers,
          when_month: {
            type: "choice",
            choice: "December",
            confidence: 1,
            probabilities: { December: 3 },
          },
        },
      }),
    ],
    [
      "an answer missing",
      (r: JevWireReply) => {
        const { confirms_appointment: _, ...answers } = r.answers;
        return { ...r, answers };
      },
    ],
    [
      "no input token count",
      (r: JevWireReply) => ({
        ...r,
        usage: { input_tokens: null, output_tokens: 3 },
      }),
    ],
  ])("a Jev reply with %s fails the row once without a retry", async (_, change) => {
    const h = await setup();
    jevRepliesWith(EYE_EXAM, change);
    const itemId = await receive(h, clinic());
    await expect(h.t.action(internal.mailTriage.triage, { itemId })).rejects.toMatchObject({
      name: "NonRetryableError",
    });
    expect(await rows(h, "events")).toHaveLength(0);
  });

  test("a job that fails for good fails the row and posts once", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    await h.t.run(async (ctx) =>
      ctx.db.patch(itemId, {
        sender: {
          name: "Lakeside Eye Care",
          address: "appointments@lakesideeye.example",
          authenticated: true,
        },
        subject: "Your appointment is confirmed",
        receivedAt: NOW - 30 * MINUTE_MS,
      }),
    );
    const workId = (await item(h, itemId)).jobId!;
    const complete = () =>
      h.t.mutation(internal.mailTriage.onMailJobComplete, {
        workId,
        context: { itemId },
        result: { kind: "failed", error: "boom" },
      });
    await complete();
    await complete();
    expect((await item(h, itemId)).state).toBe("failed");
    expect(await threadAsPat(h)).toEqual([
      expect.objectContaining({
        kind: "mail",
        body: "Sunny could not read an email. Please look at it in Gmail.",
        mailHeader: {
          senderName: "Lakeside Eye Care",
          senderAddress: "appointments@lakesideeye.example",
          senderVerified: true,
          subject: "Your appointment is confirmed",
          receivedDate: "2026-11-18",
          receivedTime: "08:30",
        },
      }),
    ]);
    expect(await rows(h, "notificationOutbox")).toHaveLength(0);
  });

  test("a mail post keeps the header it was posted with", async () => {
    const h = await setup();
    poolFinishesEveryJob();
    jevSays(PHISHING);
    const itemId = await receive(h, clinic());
    await h.t.action(internal.mailTriage.triage, { itemId });
    const [posted] = await threadAsPat(h);
    await h.t.run(async (ctx) => {
      await ctx.db.patch(itemId, { subject: "A later subject" });
      await ctx.db.patch(h.householdId, { timezone: "Asia/Tokyo" });
    });
    expect(posted).toMatchObject({
      mailHeader: { subject: "Your appointment is confirmed", receivedTime: "08:30" },
    });
    expect(await threadAsPat(h)).toEqual([posted]);
  });

  test("a row whose triage never finishes is failed with one post once it passes the attempt cap", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    let now = NOW;
    const claims: string[] = [];
    for (let round = 0; round < MAX_TRIAGE_ATTEMPTS + 3; round += 1) {
      const claim = await h.t.mutation(internal.mailTriage.claimItem, { itemId });
      claims.push(claim.kind);
      now += 16 * MINUTE_MS;
      vi.setSystemTime(now);
      await h.t.mutation(internal.mailTriage.sweepStuck, {});
    }
    expect(claims.filter((k) => k === "claimed")).toHaveLength(MAX_TRIAGE_ATTEMPTS);
    expect(await item(h, itemId)).toMatchObject({
      state: "failed",
      attempt: MAX_TRIAGE_ATTEMPTS,
    });
    expect(await threadAsPat(h)).toEqual([
      expect.objectContaining({
        kind: "mail",
        body: "Sunny could not read an email. Please look at the inbox in Gmail.",
        mailHeader: null,
      }),
    ]);
    expect(await rows(h, "notificationOutbox")).toHaveLength(0);
  });

  test("a failed job leaves alone a row that a newer job holds", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    const firstJob = (await item(h, itemId)).jobId;
    expect(await h.t.mutation(internal.mailTriage.claimItem, { itemId })).toMatchObject({
      kind: "claimed",
    });
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(1);
    const secondJob = (await item(h, itemId)).jobId;
    expect(secondJob).toBeDefined();
    expect(secondJob).not.toBe(firstJob);
    const fail = (workId: WorkId) =>
      h.t.mutation(internal.mailTriage.onMailJobComplete, {
        workId,
        context: { itemId },
        result: { kind: "failed", error: "boom" },
      });
    await fail(firstJob!);
    expect((await item(h, itemId)).state).toBe("queued");
    expect(await rows(h, "chatPosts")).toHaveLength(0);
    await fail(secondJob!);
    expect((await item(h, itemId)).state).toBe("failed");
    expect(await rows(h, "chatPosts")).toHaveLength(1);
  });

  test("a job that fails before reading the message posts without sender or subject", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    await h.t.mutation(internal.mailTriage.onMailJobComplete, {
      workId: (await item(h, itemId)).jobId!,
      context: { itemId },
      result: { kind: "failed", error: "boom" },
    });
    expect((await rows(h, "chatPosts"))[0]!.body).toBe(
      "Sunny could not read an email. Please look at the inbox in Gmail.",
    );
  });

  test("a transient Gmail error releases the claim for the pool to retry", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    gmailMocks.getMessage.mockRejectedValue(new GoogleApiError(503, "unavailable"));
    await expect(h.t.action(internal.mailTriage.triage, { itemId })).rejects.toThrow("503");
    expect(await item(h, itemId)).toMatchObject({ state: "queued", attempt: 1 });
  });

  test("a permanent Gmail error is not retried", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    gmailMocks.getMessage.mockRejectedValue(new GoogleApiError(400, "bad request"));
    await expect(h.t.action(internal.mailTriage.triage, { itemId })).rejects.toMatchObject({
      name: "NonRetryableError",
    });
  });

  test("revoked access during triage marks the mailbox once and notifies once", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    const otherId = await receive(h, clinic());
    googleMocks.refreshAccessToken.mockRejectedValue(new GoogleAccessRevoked("invalid_grant"));
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("mailbox_lost");
    expect(await h.t.action(internal.mailTriage.triage, { itemId: otherId })).toBe("skipped");
    await h.t.mutation(internal.googleGrant.markGrant, {
      row: { table: "mailboxes", id: h.mailboxId },
      refreshToken: "box:refresh-1",
      status: "error",
      error: "again",
    });
    const mailbox = await h.t.run(async (ctx) => await ctx.db.get(h.mailboxId));
    expect(mailbox).toMatchObject({ status: "revoked" });
    const posts = await rows(h, "chatPosts");
    expect(posts.map((p) => [p.kind, p.body])).toEqual([
      ["mailbox", `Sunny can no longer read ${MAILBOX}. Reconnect Gmail to keep mail coming in.`],
    ]);
    const pushes = await rows(h, "notificationOutbox");
    expect(pushes.map((p) => [p.kind, p.title])).toEqual(
      Array.from({ length: 3 }, () => ["mail_escalation", "Reconnect Gmail for Mom"]),
    );
    expect((await item(h, otherId)).state).toBe("queued");
    expect((await item(h, itemId)).state).toBe("queued");
    vi.setSystemTime(NOW + 16 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(0);
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("skipped");
    expect((await item(h, itemId)).state).toBe("queued");
  });

  test("Google denying access during triage marks the mailbox once with one notice and no item posts", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    const otherId = await receive(h, clinic());
    gmailMocks.getMessage.mockRejectedValue(new GoogleApiError(403, "insufficientPermissions"));
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("mailbox_lost");
    expect(await h.t.action(internal.mailTriage.triage, { itemId: otherId })).toBe("skipped");
    const mailbox = await h.t.run(async (ctx) => await ctx.db.get(h.mailboxId));
    expect(mailbox).toMatchObject({ status: "error" });
    const posts = await rows(h, "chatPosts");
    expect(posts.map((p) => p.kind)).toEqual(["mailbox"]);
    expect((await rows(h, "notificationOutbox")).map((p) => p.kind)).toEqual(
      Array.from({ length: 3 }, () => "mail_escalation"),
    );
  });

  test("an email of the old account whose triage finishes after a reconnect to another account changes nothing", async () => {
    const h = await setup();
    jevSays(EYE_EXAM);
    const email = clinic();
    const itemId = await receive(h, email);
    gmailMocks.getMessage.mockImplementationOnce(async () => {
      await reconnectAs(h, "other@example.com");
      return rawEmail(email);
    });

    await h.t.action(internal.mailTriage.triage, { itemId });

    expect(await rows(h, "events")).toEqual([]);
    expect(await rows(h, "seniorNotes")).toEqual([]);
    expect((await rows(h, "chatPosts")).map((p) => p.body)).toEqual([
      "Sunny now reads other@example.com.",
    ]);
    expect(await rows(h, "notificationOutbox")).toEqual([]);
    expect((await item(h, itemId)).state).toBe("failed");
  });

  test("revoked access of the old account during triage after a reconnect leaves the new account active and quiet, and the retry drops the email", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    let reconnected = false;
    googleMocks.refreshAccessToken.mockImplementation(async (refresh: string) => {
      if (reconnected && refresh === "refresh-1") throw new GoogleAccessRevoked("invalid_grant");
      return { accessToken: `access-for-${refresh}`, expiresAt: Date.now() + 3_600_000 };
    });
    gmailMocks.getMessage.mockImplementationOnce(async () => {
      await reconnectAs(h, "other@example.com");
      reconnected = true;
      throw new GoogleApiError(401, "unauthorized");
    });

    await h.t.action(internal.mailTriage.triage, { itemId });
    expect((await item(h, itemId)).state).toBe("queued");
    await h.t.action(internal.mailTriage.triage, { itemId });

    const mailbox = await h.t.run(async (ctx) => await ctx.db.get(h.mailboxId));
    expect(mailbox).toMatchObject({ accountEmail: "other@example.com", status: "active" });
    expect((await item(h, itemId)).state).toBe("failed");
    expect((await rows(h, "chatPosts")).map((p) => p.body)).toEqual([
      "Sunny now reads other@example.com.",
    ]);
    expect(await rows(h, "notificationOutbox")).toEqual([]);
  });

  test("the sweeper moves the pickup deadline of a queued row whose job still waits in the pool", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    const job = (await item(h, itemId)).jobId;
    expect(await h.t.run(async (ctx) => (await mailPool.status(ctx, job!)).state)).toBe("pending");
    vi.setSystemTime(NOW + 16 * MINUTE_MS);

    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(0);

    expect(await item(h, itemId)).toMatchObject({
      state: "queued",
      jobId: job,
      leaseUntil: NOW + 31 * MINUTE_MS,
    });
  });

  test("the sweeper enqueues a queued row again once its job has left the pool", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    const job = (await item(h, itemId)).jobId;
    poolFinishesEveryJob();
    vi.setSystemTime(NOW + 16 * MINUTE_MS);

    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(1);

    expect((await item(h, itemId)).jobId).not.toBe(job);
  });

  test("new mail is queued with a pickup deadline and a triage job", async () => {
    const h = await setup();
    const itemId: Id<"mailItems"> = await receive(h, clinic());
    const row = await item(h, itemId);
    expect(row).toMatchObject({ account: MAILBOX, state: "queued", attempt: 0 });
    expect(row.leaseUntil! - NOW).toBeGreaterThanOrEqual(15 * MINUTE_MS);
    expect(row.leaseUntil! - NOW).toBeLessThan(15 * MINUTE_MS + 1000);
  });
});
