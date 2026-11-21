import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { gmailMocks } from "./googleMocks.helpers";
import { SENIOR_SENTENCES } from "./lib/mailTypes";
import { item, jevCalls, receive, rows, triageEmail } from "./mailMocks.helpers";
import { EYE_EXAM, NOW } from "./lib/mailFixtures.helpers";
import { MINUTE_MS } from "./lib/time";
import { DELIVERY, PHISHING, clinic, setup, useTriageClock } from "./mailTriage.helpers";

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

describe("other verdicts", () => {
  test("a delivery notice creates a senior note pushed to the senior phone only", async () => {
    const h = await setup();
    const done = await triageEmail(
      h,
      clinic({ from: "Northgate Pharmacy <rx@northgate.example>", subject: "On its way" }),
      DELIVERY,
    );
    const [note] = await rows(h, "seniorNotes");
    expect(note).toMatchObject({
      householdId: h.householdId,
      mailItemId: done._id,
      text: SENIOR_SENTENCES.package_coming,
      receivedAt: NOW - 30 * MINUTE_MS,
    });
    expect(note!.expiresAt).toBe(Date.parse("2026-11-20T05:00:00Z"));
    expect(done.effects).toEqual([{ kind: "senior_note", noteId: note!._id }]);
    const pushes = await rows(h, "notificationOutbox");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      kind: "senior_note",
      title: "Sunny",
      body: SENIOR_SENTENCES.package_coming,
      recipientDeviceId: h.phoneId,
      seniorNoteId: note!._id,
    });
    expect(await rows(h, "chatPosts")).toHaveLength(0);
  });

  test("the fourth senior note of a local day goes to the caregivers without a push", async () => {
    const h = await setup();
    const done = [];
    for (let i = 0; i < 4; i += 1) {
      vi.setSystemTime(NOW + i * 60 * MINUTE_MS);
      done.push(
        await triageEmail(h, clinic({ receivedAt: NOW + (i - 1) * 60 * MINUTE_MS }), DELIVERY),
      );
    }
    expect(done.map((d) => d.effects?.[0]?.kind)).toEqual([
      "senior_note",
      "senior_note",
      "senior_note",
      "told_caregivers",
    ]);
    expect(done[3]!.effects).toEqual([{ kind: "told_caregivers", pushed: false }]);
    expect(await rows(h, "seniorNotes")).toHaveLength(3);
    const pushes = await rows(h, "notificationOutbox");
    expect(pushes.map((p) => p.kind)).toEqual(["senior_note", "senior_note", "senior_note"]);
    const posts = await rows(h, "chatPosts");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toContain("daily limit");
    expect(posts[0]!.body).toContain(SENIOR_SENTENCES.package_coming);
  });

  test("the note limit starts again on the next local day", async () => {
    const h = await setup();
    for (let i = 0; i < 3; i += 1) await triageEmail(h, clinic(), DELIVERY);
    vi.setSystemTime(Date.parse("2026-11-19T05:30:00Z"));
    const next = await triageEmail(
      h,
      clinic({ receivedAt: Date.parse("2026-11-19T05:00:00Z") }),
      DELIVERY,
    );
    expect(next.effects?.[0]?.kind).toBe("senior_note");
  });

  test("a phishing email reaches the caregivers and never the senior", async () => {
    const h = await setup();
    const done = await triageEmail(h, clinic({ subject: "Grandma help" }), PHISHING);
    expect(done.effects).toEqual([{ kind: "escalated", reason: "money_request", pushed: true }]);
    expect(await rows(h, "chatPosts")).toHaveLength(1);
    const pushes = await rows(h, "notificationOutbox");
    expect(pushes.every((p) => p.kind === "mail_escalation")).toBe(true);
    expect(pushes.every((p) => p.recipientDeviceId === undefined)).toBe(true);
    expect(pushes).toHaveLength(3);
    expect(await rows(h, "seniorNotes")).toHaveLength(0);
  });

  test("an escalation push says what Sunny needs, without the subject or the sender's name", async () => {
    const h = await setup();
    await triageEmail(
      h,
      clinic({ from: "Grandson Tom <tom@example.org>", subject: "Grandma please help now" }),
      PHISHING,
    );
    const pushes = await rows(h, "notificationOutbox");
    expect(pushes).toHaveLength(3);
    for (const push of pushes) {
      expect(push.body).toBe(
        "Sunny thinks this email may be a scam and did not tell the senior about it.",
      );
    }
  });

  test("the seventh escalation in an hour posts without a push", async () => {
    const h = await setup();
    const done = [];
    for (let i = 0; i < 7; i += 1) done.push(await triageEmail(h, clinic(), PHISHING));
    expect(done.map((d) => d.effects?.[0])).toEqual([
      ...Array.from({ length: 6 }, () => ({
        kind: "escalated",
        reason: "money_request",
        pushed: true,
      })),
      { kind: "escalated", reason: "money_request", pushed: false },
    ]);
    expect(await rows(h, "chatPosts")).toHaveLength(7);
    expect(await rows(h, "notificationOutbox")).toHaveLength(18);
  });

  test("mail Gmail filed as a promotion is ignored without the model", async () => {
    const h = await setup();
    const done = await triageEmail(h, clinic({ labels: ["INBOX", "CATEGORY_PROMOTIONS"] }));
    expect(done).toMatchObject({ state: "done", rule: "ignore", effects: [] });
    expect(jevCalls).toHaveLength(0);
  });

  test("a message Gmail no longer has is done with no effects", async () => {
    const h = await setup();
    const itemId = await receive(h, clinic());
    gmailMocks.getMessage.mockResolvedValue(null);
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("gone");
    expect(await item(h, itemId)).toMatchObject({ state: "done", rule: "gone", effects: [] });
  });

  test("a verified address that sends a scam still escalates and reaches neither the senior nor the calendar", async () => {
    const h = await setup();
    const done = await triageEmail(h, clinic({ subject: "Please wire the copay" }), {
      ...EYE_EXAM,
      yes: ["confirms_appointment", "asks_hard_to_trace_payment"],
    });
    expect(done.effects).toEqual([{ kind: "escalated", reason: "money_request", pushed: true }]);
    expect(await rows(h, "events")).toHaveLength(0);
    expect(await rows(h, "seniorNotes")).toHaveLength(0);
  });
});
