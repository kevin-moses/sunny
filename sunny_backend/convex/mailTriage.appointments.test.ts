import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { JEV_MODEL } from "./lib/jevClient";
import type { Triaged } from "./lib/mailTypes";
import { jevCalls, receive, rows, triageEmail } from "./mailMocks.helpers";
import type { MailHousehold } from "./mailMocks.helpers";
import { EYE_EXAM, NOW } from "./lib/mailFixtures.helpers";
import { DAY_MS, MINUTE_MS } from "./lib/time";
import { MOVED_EYE_EXAM, clinic, invite, kinds, setup, useTriageClock } from "./mailTriage.helpers";
import { insertEvent } from "./testing.helpers";

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

describe("an appointment email", () => {
  test("a clinic confirmation adds one event with a link, one chat post and no push", async () => {
    const h = await setup();
    const done = await triageEmail(h, clinic(), EYE_EXAM);

    expect(done).toMatchObject({
      state: "done",
      subject: "Your appointment is confirmed",
      sender: {
        address: "appointments@lakesideeye.example",
        authenticated: true,
      },
      verdict: "appointment",
      rule: "new-add",
      judgeRule: "confirmed-appointment",
      classifier: { name: JEV_MODEL, usage: { inputTokens: 4200, outputTokens: 310 } },
    });
    expect(done.judgeAnswers).toMatchObject({
      confirms_appointment: 0.95,
      addresses_assistant: 0.02,
      appointment_kind: { choice: "eye_doctor", probability: 0.95 },
    });
    expect(JSON.stringify(done.judgeAnswers)).not.toContain("Dr. Rivera");
    const [event] = await rows(h, "events");
    expect(event).toMatchObject({
      title: "Eye exam",
      startsOn: "2026-12-10",
      startTime: "14:15",
      createdVia: "agent",
    });
    expect(event!.place).toBeUndefined();
    expect(event!.notes).toBeUndefined();
    expect(done.effects).toEqual([
      { kind: "event_added", eventId: event!._id },
      { kind: "told_caregivers", pushed: false },
    ]);
    const links = await rows(h, "mailEventLinks");
    expect(links).toMatchObject([{ eventId: event!._id, mailItemId: done._id }]);
    const posts = await rows(h, "chatPosts");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: "mail", mailItemId: done._id });
    expect(posts[0]!.body).toContain("Sunny added Eye exam, Thursday, December 10 at 2:15 PM");
    expect(await rows(h, "notificationOutbox")).toHaveLength(0);
  });

  test("a confirmation that also asks for a payment adds the event and escalates once", async () => {
    const h = await setup();
    const done = await triageEmail(h, clinic(), {
      ...EYE_EXAM,
      yes: ["confirms_appointment", "about_bill"],
    });
    const [event] = await rows(h, "events");
    expect(event).toMatchObject({ title: "Eye exam", startsOn: "2026-12-10", startTime: "14:15" });
    expect(done.effects).toEqual([
      { kind: "event_added", eventId: event!._id },
      { kind: "escalated", reason: "bill_or_payment", pushed: true },
    ]);
    const posts = await rows(h, "chatPosts");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toContain(
      "Sunny added Eye exam, Thursday, December 10 at 2:15 PM, to the calendar. The email is also about a bill or a payment.",
    );
    expect(kinds(await rows(h, "notificationOutbox"))).toEqual([
      "mail_escalation",
      "mail_escalation",
      "mail_escalation",
    ]);
  });

  test("mail changes the calendar at most five times a local day, then escalates", async () => {
    const h = await setup();
    for (let day = 10; day < 15; day += 1) {
      const done = await triageEmail(h, clinic(), {
        ...EYE_EXAM,
        when: { date: `2026-12-${day}`, time: "14:15" },
      });
      expect(done.effects?.[0]).toMatchObject({ kind: "event_added" });
      expect(done.calendarChangedAt).toBeGreaterThanOrEqual(NOW);
    }
    const sixth = await triageEmail(h, clinic(), {
      ...EYE_EXAM,
      when: { date: "2026-12-16", time: "14:15" },
    });
    expect(sixth.effects).toEqual([
      {
        kind: "escalated",
        reason: "daily_limit",
        pushed: true,
        proposed: { kind: "eye_doctor", date: "2026-12-16", time: "14:15" },
      },
    ]);
    expect(sixth.calendarChangedAt).toBeUndefined();
    expect(await rows(h, "events")).toHaveLength(5);
    expect((await rows(h, "notificationOutbox")).at(-1)!.body).toContain(
      "because the daily limit of 5 calendar changes from email was reached",
    );

    vi.setSystemTime(NOW + DAY_MS);
    const nextDay = await triageEmail(h, clinic({ receivedAt: NOW + DAY_MS - MINUTE_MS }), {
      ...EYE_EXAM,
      when: { date: "2026-12-16", time: "14:15" },
    });
    expect(nextDay.effects?.[0]).toMatchObject({ kind: "event_added" });
  });

  test("the same triage applied twice, or late after a re-claim, adds nothing more", async () => {
    const h = await setup();
    const email = clinic();
    const itemId = await receive(h, email);
    const triaged: Triaged = {
      verdict: {
        kind: "appointment",
        change: "new",
        appointment: {
          kind: "eye_doctor",
          date: "2026-12-10",
          time: "14:15",
          durationMinutes: null,
        },
        decision: null,
      },
      summary: "The email confirms an appointment.",
      rule: "confirmed-appointment",
      classifier: {
        name: JEV_MODEL,
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 },
      },
      answers: { confirms_appointment: 0.95 },
    };
    const header = {
      sender: {
        name: "Lakeside Eye Care",
        address: "appointments@lakesideeye.example",
        authenticated: true,
      },
      subject: email.subject,
      receivedAt: email.receivedAt,
    };
    const apply = (attempt: number) =>
      h.t.mutation(internal.mailTriage.applyTriage, { itemId, attempt, ics: null, triaged });

    await h.t.mutation(internal.mailTriage.claimItem, { itemId });
    vi.setSystemTime(NOW + 11 * MINUTE_MS);
    expect(await h.t.mutation(internal.mailTriage.sweepStuck, {})).toBe(1);
    const again = await h.t.mutation(internal.mailTriage.claimItem, { itemId });
    expect(again).toMatchObject({ kind: "claimed", attempt: 2 });
    await h.t.mutation(internal.mailTriage.recordParsed, {
      itemId,
      attempt: 2,
      ...header,
      icsKey: null,
    });

    expect(await apply(1)).toBe("lost");
    expect(await apply(2)).toBe("posted");
    expect(await apply(2)).toBe("lost");

    expect(await rows(h, "events")).toHaveLength(1);
    expect(await rows(h, "mailEventLinks")).toHaveLength(1);
    expect(await rows(h, "chatPosts")).toHaveLength(1);
  });

  test("a second email about the same appointment records already_on_calendar", async () => {
    const h = await setup();
    await triageEmail(h, clinic(), EYE_EXAM);
    const reminder = await triageEmail(h, clinic({ subject: "Reminder" }), EYE_EXAM);
    const [event] = await rows(h, "events");
    expect(await rows(h, "events")).toHaveLength(1);
    expect(reminder.effects).toEqual([{ kind: "already_on_calendar", eventId: event!._id }]);
    expect(reminder.rule).toBe("new-on-calendar");
    expect(await rows(h, "chatPosts")).toHaveLength(1);
  });

  test("a reschedule from another verified address moves the event and the link and pushes caregivers", async () => {
    const h = await setup();
    await triageEmail(h, clinic(), EYE_EXAM);
    const moved = await triageEmail(
      h,
      clinic({ from: "Lakeside <reminders@lakesideeye.example>", subject: "Moved" }),
      MOVED_EYE_EXAM,
    );
    const [event] = await rows(h, "events");
    expect(event).toMatchObject({ startsOn: "2026-12-12", startTime: "10:00" });
    expect(moved.effects).toEqual([
      {
        kind: "event_rescheduled",
        eventId: event!._id,
        fromDate: "2026-12-10",
        fromTime: "14:15",
      },
      { kind: "told_caregivers", pushed: true },
    ]);
    expect(
      (await rows(h, "mailEventLinks")).map((l) => [l.appointmentKey, l.senderDomain, l.eventId]),
    ).toContainEqual(["appt:2026-12-12:10:00:eye exam", "lakesideeye.example", event!._id]);
    const pushes = await rows(h, "notificationOutbox");
    expect(kinds(pushes)).toEqual(["mail_update", "mail_update", "mail_update"]);
    expect(pushes.map((p) => p.recipientUserId).sort()).toEqual(["max", "pat", "val"]);
    expect(pushes[0]!.title).toBe("Sunny moved an appointment");
    expect(pushes[0]!.body).toBe(
      "Sunny moved Eye exam from Thursday, December 10 at 2:15 PM to Saturday, December 12 at 10:00 AM.",
    );
  });

  test("a verified sender's reschedule moves a hand-entered event and keeps its place", async () => {
    const h = await setup();
    const eventId = await insertEvent(h.t, h.householdId, {
      title: "Eye exam",
      startsOn: "2026-12-10",
      startTime: "14:15",
      place: "Lakeside Eye Care",
    });
    const moved = await triageEmail(h, clinic(), MOVED_EYE_EXAM);
    expect(moved.effects).toEqual([
      { kind: "event_rescheduled", eventId, fromDate: "2026-12-10", fromTime: "14:15" },
      { kind: "told_caregivers", pushed: true },
    ]);
    expect((await rows(h, "events"))[0]).toMatchObject({
      startsOn: "2026-12-12",
      startTime: "10:00",
      place: "Lakeside Eye Care",
    });
  });

  test("an unverified sender's reschedule escalates and moves nothing", async () => {
    const h = await setup();
    const eventId = await insertEvent(h.t, h.householdId, {
      title: "Eye exam",
      startsOn: "2026-12-10",
      startTime: "14:15",
    });
    const moved = await triageEmail(h, clinic({ verified: false }), MOVED_EYE_EXAM);
    expect(moved.effects).toEqual([
      {
        kind: "escalated",
        reason: "unclear_reschedule",
        pushed: true,
        eventId,
        proposed: { kind: "eye_doctor", date: "2026-12-12", time: "10:00" },
      },
    ]);
    expect((await rows(h, "events"))[0]).toMatchObject({
      startsOn: "2026-12-10",
      startTime: "14:15",
    });
    expect(await rows(h, "mailEventLinks")).toHaveLength(0);
    expect((await rows(h, "chatPosts"))[0]!.body).toContain(
      "Sunny did not move Eye exam, Thursday, December 10 at 2:15 PM, because Gmail could not verify the sender. The email asks to move it to Saturday, December 12 at 10:00 AM. Tell Sunny in chat to move it if the email is genuine.",
    );
    expect((await rows(h, "notificationOutbox"))[0]!.body).toBe(
      "Sunny did not move Eye exam, Thursday, December 10 at 2:15 PM, because Gmail could not verify the sender. The email asks to move it to Saturday, December 12 at 10:00 AM. Tell...",
    );
    expect(kinds(await rows(h, "notificationOutbox"))).toEqual([
      "mail_escalation",
      "mail_escalation",
      "mail_escalation",
    ]);
  });

  describe("with a weekly series on the calendar", () => {
    async function weeklyEyeExam(h: MailHousehold): Promise<Id<"events">> {
      return await insertEvent(h.t, h.householdId, {
        title: "Eye exam",
        startsOn: "2026-11-19",
        startTime: "14:15",
        durationMinutes: 30,
        repeatDays: [4],
      });
    }

    test("a confirmation of one of its dates is already on the calendar", async () => {
      const h = await setup();
      const seriesId = await weeklyEyeExam(h);
      const done = await triageEmail(h, clinic(), EYE_EXAM);
      expect(done.effects).toEqual([{ kind: "already_on_calendar", eventId: seriesId }]);
      expect(await rows(h, "events")).toHaveLength(1);
    });

    test("a reschedule of one of its dates from a verified sender escalates and moves nothing", async () => {
      const h = await setup();
      const seriesId = await weeklyEyeExam(h);
      const moved = await triageEmail(h, clinic(), MOVED_EYE_EXAM);
      expect(moved.effects).toEqual([
        {
          kind: "escalated",
          reason: "unclear_reschedule",
          pushed: true,
          eventId: seriesId,
          proposed: { kind: "eye_doctor", date: "2026-12-12", time: "10:00" },
        },
      ]);
      expect((await rows(h, "events"))[0]).toMatchObject({
        startsOn: "2026-11-19",
        startTime: "14:15",
        repeatDays: [4],
      });
    });
  });

  test("a cancellation escalates with the event and the event stays", async () => {
    const h = await setup();
    await triageEmail(h, clinic(), EYE_EXAM);
    const [event] = await rows(h, "events");
    const cancelled = await triageEmail(h, clinic({ subject: "Cancelled" }), {
      yes: ["appointment_cancelled"],
      kind: "eye_doctor",
      before: { date: "2026-12-10", time: "14:15" },
    });
    expect(cancelled.effects).toEqual([
      { kind: "escalated", reason: "cancellation", pushed: true, eventId: event!._id },
    ]);
    expect((await rows(h, "events"))[0]!.deletedAt).toBeUndefined();
    const pushes = await rows(h, "notificationOutbox");
    expect(pushes[0]!.title).toBe("Email for Mom needs you");
    expect(pushes[0]!.title).not.toContain("Cancelled");
  });

  test("an invite goes to Jev, takes its start from the calendar part and is linked by its UID", async () => {
    const h = await setup();
    const ics = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:visit-42@lakesideeye.example",
      "DTSTART;TZID=America/New_York:20261210T141500",
      "DURATION:PT30M",
      "SUMMARY:Call Officer Miller back",
      "LOCATION:Lakeside Eye Care\\, 40 Harbor Road",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const done = await triageEmail(h, clinic({ ics }), { kind: "eye_doctor" });
    expect(jevCalls).toHaveLength(1);
    expect(done).toMatchObject({ judgeRule: "ics-invitation", rule: "new-add" });
    const [event] = await rows(h, "events");
    expect(event).toMatchObject({
      title: "Eye exam",
      startsOn: "2026-12-10",
      startTime: "14:15",
      durationMinutes: 30,
    });
    expect(event!.place).toBeUndefined();
    expect((await rows(h, "chatPosts"))[0]!.body).toContain(
      "Place in the invitation: Lakeside Eye Care, 40 Harbor Road",
    );
    expect((await rows(h, "mailEventLinks"))[0]!.appointmentKey).toBe(
      "ics:visit-42@lakesideeye.example",
    );
    const repeat = await triageEmail(h, clinic({ ics }), { kind: "eye_doctor" });
    expect(repeat.effects).toEqual([{ kind: "already_on_calendar", eventId: event!._id }]);
  });

  test("an invite update older than the one Sunny linked is ignored", async () => {
    const h = await setup();
    await triageEmail(h, clinic({ ics: invite(["DTSTART:20261210T191500Z", "SEQUENCE:0"]) }), {
      kind: "eye_doctor",
    });
    await triageEmail(h, clinic({ ics: invite(["DTSTART:20261211T191500Z", "SEQUENCE:2"]) }));
    expect((await rows(h, "mailEventLinks"))[0]).toMatchObject({ sequence: 2 });
    const late = await triageEmail(
      h,
      clinic({ ics: invite(["DTSTART:20261212T191500Z", "SEQUENCE:1"]) }),
    );
    expect(late).toMatchObject({
      judgeRule: "gate:ics:older_sequence",
      classifier: { name: "gate" },
    });
    expect(late.effects).toEqual([]);
    expect((await rows(h, "events"))[0]).toMatchObject({ startsOn: "2026-12-11" });
  });

  test("an invite resent at the same time raises the stored SEQUENCE, so an older one cannot move it", async () => {
    const h = await setup();
    await triageEmail(h, clinic({ ics: invite(["DTSTART:20261210T191500Z", "SEQUENCE:0"]) }), {
      kind: "eye_doctor",
    });
    const resent = await triageEmail(
      h,
      clinic({ ics: invite(["DTSTART:20261210T191500Z", "SEQUENCE:3"]) }),
    );
    expect(resent.effects).toEqual([
      { kind: "already_on_calendar", eventId: (await rows(h, "events"))[0]!._id },
    ]);
    expect((await rows(h, "mailEventLinks"))[0]).toMatchObject({ sequence: 3 });
    const older = await triageEmail(
      h,
      clinic({ ics: invite(["DTSTART:20261211T191500Z", "SEQUENCE:2"]) }),
    );
    expect(older.judgeRule).toBe("gate:ics:older_sequence");
    expect((await rows(h, "events"))[0]).toMatchObject({ startsOn: "2026-12-10" });
  });
});
