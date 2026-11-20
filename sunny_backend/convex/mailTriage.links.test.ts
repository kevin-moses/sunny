import { describe, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { rows, triageEmail } from "./mailMocks.helpers";
import type { JevSays, MailHousehold, RawEmail } from "./mailMocks.helpers";
import {
  DAY,
  EYE_EXAM,
  MINUTE,
  MOVED_EYE_EXAM,
  NOW,
  clinic,
  invite,
  kinds,
  setup,
  useTriageClock,
} from "./mailTriage.helpers";
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

describe("links belong to the sender's domain", () => {
  const STRANGER = "Desk <events@attacker.example>";
  const CLINIC = "Lakeside <appointments@lakesideeye.example>";
  const CLINIC_UID = "visit-42@lakesideeye.example";

  function invitation(from: string, uid: string, lines: string[]): RawEmail {
    return clinic({
      from,
      subject: "Invitation",
      text: "See the invitation.",
      ics: invite(lines, uid),
    });
  }

  const AT_SLOT = "DTSTART:20261210T191500Z";
  const NEW_DAY = "DTSTART:20261212T150000Z";

  async function handEnteredEyeExam(h: MailHousehold): Promise<Id<"events">> {
    return await insertEvent(h.t, h.householdId, {
      title: "Eye exam with Dr. Rivera",
      startsOn: "2026-12-10",
      startTime: "14:15",
      place: "Lakeside Eye Care",
    });
  }

  function slots(events: { startsOn: string; startTime: string }[]): string[] {
    return events.map((e) => `${e.startsOn} ${e.startTime}`);
  }

  test("a verified invite at a hand-entered event's slot links its UID for its own domain", async () => {
    const h = await setup();
    const eventId = await handEnteredEyeExam(h);
    const done = await triageEmail(h, invitation(CLINIC, CLINIC_UID, [AT_SLOT]), {
      kind: "eye_doctor",
    });
    expect(done.effects).toEqual([{ kind: "already_on_calendar", eventId }]);
    expect(await rows(h, "mailEventLinks")).toEqual([
      expect.objectContaining({
        eventId,
        appointmentKey: `ics:${CLINIC_UID}`,
        senderDomain: "lakesideeye.example",
        sequence: 0,
      }),
    ]);
  });

  test("two domains each hold a link on one event", async () => {
    const h = await setup();
    const eventId = await handEnteredEyeExam(h);
    await triageEmail(h, invitation(STRANGER, "evil-1@attacker.example", [AT_SLOT]), {
      kind: "eye_doctor",
    });
    await triageEmail(h, invitation(CLINIC, CLINIC_UID, [AT_SLOT]), { kind: "eye_doctor" });
    const links = await rows(h, "mailEventLinks");
    expect(links.map((l) => [l.senderDomain, l.appointmentKey, l.eventId]).sort()).toEqual([
      ["attacker.example", "ics:evil-1@attacker.example", eventId],
      ["lakesideeye.example", `ics:${CLINIC_UID}`, eventId],
    ]);
  });

  test("a stranger's link on the event does not stop the clinic's update from moving it", async () => {
    const h = await setup();
    const eventId = await handEnteredEyeExam(h);
    await triageEmail(h, invitation(STRANGER, "evil-1@attacker.example", [AT_SLOT]), {
      kind: "eye_doctor",
    });
    await triageEmail(h, invitation(CLINIC, CLINIC_UID, [AT_SLOT]), { kind: "eye_doctor" });
    const update = await triageEmail(h, invitation(CLINIC, CLINIC_UID, [NEW_DAY, "SEQUENCE:1"]), {
      kind: "eye_doctor",
    });
    expect(update.effects?.[0]).toEqual({
      kind: "event_rescheduled",
      eventId,
      fromDate: "2026-12-10",
      fromTime: "14:15",
    });
    expect(slots(await rows(h, "events"))).toEqual(["2026-12-12 10:00"]);
  });

  test("a stranger's high SEQUENCE on the clinic's UID changes nothing the clinic's mail sees", async () => {
    const h = await setup();
    const eventId = await handEnteredEyeExam(h);
    await triageEmail(h, invitation(CLINIC, CLINIC_UID, [AT_SLOT]), { kind: "eye_doctor" });
    await triageEmail(h, invitation(STRANGER, CLINIC_UID, [AT_SLOT, "SEQUENCE:999999"]), {
      kind: "eye_doctor",
    });
    const update = await triageEmail(h, invitation(CLINIC, CLINIC_UID, [NEW_DAY, "SEQUENCE:1"]), {
      kind: "eye_doctor",
    });
    expect(update.judgeRule).not.toBe("gate:ics:older_sequence");
    expect(update.effects?.[0]).toMatchObject({ kind: "event_rescheduled", eventId });
    expect(slots(await rows(h, "events"))).toEqual(["2026-12-12 10:00"]);
    const clinicLink = (await rows(h, "mailEventLinks")).find(
      (l) => l.senderDomain === "lakesideeye.example",
    );
    expect(clinicLink).toMatchObject({ appointmentKey: `ics:${CLINIC_UID}`, sequence: 1 });
  });

  test("a UID a stranger linked first does not steer the clinic's own invite", async () => {
    const h = await setup();
    const eventId = await handEnteredEyeExam(h);
    await triageEmail(h, invitation(STRANGER, CLINIC_UID, [AT_SLOT]), { kind: "eye_doctor" });
    const genuine = await triageEmail(h, invitation(CLINIC, CLINIC_UID, [NEW_DAY]), {
      kind: "eye_doctor",
    });
    expect(kinds(genuine.effects ?? [])).toEqual(["event_added", "told_caregivers"]);
    const events = await rows(h, "events");
    expect(events.find((e) => e._id === eventId)).toMatchObject({
      startsOn: "2026-12-10",
      startTime: "14:15",
    });
  });

  const LOOKALIKE = "@lakesideeye.example.attacker.example";
  const OVER_LONG = `Lakeside <${"x".repeat(255 - LOOKALIKE.length)}${LOOKALIKE}>`;

  test("an address over 254 characters is no sender, so its email closes unread and changes nothing", async () => {
    const h = await setup();
    const eventId = await handEnteredEyeExam(h);
    await triageEmail(h, invitation(CLINIC, CLINIC_UID, [AT_SLOT]), { kind: "eye_doctor" });
    for (const lines of [
      [AT_SLOT, "SEQUENCE:999999"],
      [NEW_DAY, "SEQUENCE:1"],
    ]) {
      const unread = await triageEmail(h, invitation(OVER_LONG, CLINIC_UID, lines), {
        kind: "eye_doctor",
      });
      expect(unread).toMatchObject({ state: "done", rule: "unparseable", effects: [] });
      expect(unread.sender).toBeUndefined();
    }
    expect(slots(await rows(h, "events"))).toEqual(["2026-12-10 14:15"]);
    expect(await rows(h, "mailEventLinks")).toEqual([
      expect.objectContaining({ senderDomain: "lakesideeye.example", sequence: 0, eventId }),
    ]);
    expect(await rows(h, "chatPosts")).toHaveLength(0);
    expect(await rows(h, "notificationOutbox")).toHaveLength(0);
    const update = await triageEmail(h, invitation(CLINIC, CLINIC_UID, [NEW_DAY, "SEQUENCE:1"]), {
      kind: "eye_doctor",
    });
    expect(update.effects?.[0]).toMatchObject({ kind: "event_rescheduled", eventId });
  });

  describe("on a shared mail domain", () => {
    const HELPER = "Helper <someone.else@gmail.com>";
    const GMAIL_CLINIC = "Lakeside Eye <lakesideeye@gmail.com>";
    const OVER_ELSEWHERE =
      "The email gives Eye exam, Thursday, December 10 at 2:15 PM. An earlier email from another address at the same mail domain gave this appointment, and it is no longer coming up on Sunny's calendar, so Sunny changed nothing. Tell Sunny in chat if it should be added.";

    async function cancelOnly(h: MailHousehold): Promise<Id<"events">> {
      const [event] = await rows(h, "events");
      await h.t.run(async (ctx) => await ctx.db.patch(event!._id, { deletedAt: NOW }));
      return event!._id;
    }

    async function liveSlots(h: MailHousehold): Promise<string[]> {
      return slots((await rows(h, "events")).filter((e) => e.deletedAt === undefined));
    }

    test("a reminder from another address for an appointment one address added, moved and a caregiver cancelled asks", async () => {
      const h = await setup();
      await triageEmail(h, clinic({ from: HELPER }), EYE_EXAM);
      await triageEmail(h, clinic({ from: HELPER, subject: "Moved" }), MOVED_EYE_EXAM);
      await cancelOnly(h);
      const postsBefore = (await rows(h, "chatPosts")).length;
      const own = await triageEmail(h, clinic({ from: HELPER, subject: "Reminder" }), EYE_EXAM);
      expect(kinds(own.effects ?? [])).toEqual(["already_on_calendar"]);
      expect(await rows(h, "chatPosts")).toHaveLength(postsBefore);
      const real = await triageEmail(h, clinic({ from: GMAIL_CLINIC }), EYE_EXAM);
      expect(real.effects).toEqual([
        {
          kind: "escalated",
          reason: "unclear_appointment",
          pushed: true,
          proposed: { kind: "eye_doctor", date: "2026-12-10", time: "14:15" },
        },
      ]);
      expect(await liveSlots(h)).toEqual([]);
      const posts = await rows(h, "chatPosts");
      expect(posts).toHaveLength(postsBefore + 1);
      expect(posts.at(-1)!.body).toContain(OVER_ELSEWHERE);
      expect(posts.at(-1)!.body).not.toContain("someone.else");
    });

    test("a reminder from the address that made the link stays linked after its first email is gone", async () => {
      const h = await setup();
      const first = await triageEmail(h, clinic({ from: GMAIL_CLINIC }), EYE_EXAM);
      const eventId = await cancelOnly(h);
      await h.t.run(async (ctx) => await ctx.db.delete(first._id));
      const reminder = await triageEmail(
        h,
        clinic({ from: GMAIL_CLINIC, subject: "Reminder" }),
        EYE_EXAM,
      );
      expect(reminder.effects).toEqual([{ kind: "already_on_calendar", eventId }]);
      expect(await liveSlots(h)).toEqual([]);
    });
  });

  describe("with a hand-entered weekly therapy series", () => {
    const THERAPY: JevSays = {
      yes: ["confirms_appointment"],
      kind: "physical_therapy",
      when: { date: "2026-12-01", time: "10:00" },
    };

    async function weeklyTherapy(h: MailHousehold): Promise<Id<"events">> {
      return await insertEvent(h.t, h.householdId, {
        title: "Physical therapy",
        startsOn: "2026-10-05",
        startTime: "10:00",
        durationMinutes: 45,
        repeatDays: [2],
      });
    }

    test("a clinic's second reminder for one of its dates changes nothing and posts nothing", async () => {
      const h = await setup();
      const seriesId = await weeklyTherapy(h);
      const first = await triageEmail(h, clinic({ subject: "Reminder" }), THERAPY);
      expect(first.effects).toEqual([{ kind: "already_on_calendar", eventId: seriesId }]);
      const second = await triageEmail(h, clinic({ subject: "Reminder" }), THERAPY);
      expect(second.effects).toEqual([{ kind: "already_on_calendar", eventId: seriesId }]);
      expect(await rows(h, "events")).toHaveLength(1);
      expect(await rows(h, "chatPosts")).toHaveLength(0);
      expect(await rows(h, "notificationOutbox")).toHaveLength(0);
    });

    test("a clinic's second reminder for a date a caregiver moved the series off changes nothing and asks", async () => {
      const h = await setup();
      const seriesId = await weeklyTherapy(h);
      await triageEmail(h, clinic({ subject: "Reminder" }), THERAPY);
      await h.t.run(async (ctx) => await ctx.db.patch(seriesId, { repeatDays: [4] }));
      const second = await triageEmail(h, clinic({ subject: "Reminder" }), THERAPY);
      expect(second.effects).toEqual([
        {
          kind: "escalated",
          reason: "unclear_appointment",
          pushed: true,
          eventId: seriesId,
          proposed: { kind: "physical_therapy", date: "2026-12-01", time: "10:00" },
        },
      ]);
      expect(await rows(h, "events")).toEqual([
        expect.objectContaining({ startsOn: "2026-10-05", startTime: "10:00", repeatDays: [4] }),
      ]);
      expect((await rows(h, "notificationOutbox")).length).toBeGreaterThan(0);
      const posts = await rows(h, "chatPosts");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toContain(
        "The email gives Physical therapy, Tuesday, December 1 at 10:00 AM. Sunny's calendar no longer has this appointment at that time, so Sunny changed nothing. Tell Sunny in chat which time is right.",
      );
    });

    test("a clinic's invite moved to the series' stored start, which is none of its weekdays, changes nothing and asks", async () => {
      const h = await setup();
      const seriesId = await insertEvent(h.t, h.householdId, {
        title: "Physical therapy",
        startsOn: "2026-11-30",
        startTime: "10:00",
        durationMinutes: 45,
        repeatDays: [2],
      });
      const uid = "therapy-9@lakesideeye.example";
      const first = await triageEmail(h, invitation(CLINIC, uid, ["DTSTART:20261201T150000Z"]), {
        kind: "physical_therapy",
      });
      expect(first.effects).toEqual([{ kind: "already_on_calendar", eventId: seriesId }]);
      const moved = await triageEmail(
        h,
        invitation(CLINIC, uid, ["DTSTART:20261130T150000Z", "SEQUENCE:1"]),
        { kind: "physical_therapy" },
      );
      expect(moved.effects).toEqual([
        {
          kind: "escalated",
          reason: "unclear_reschedule",
          pushed: true,
          proposed: { kind: "physical_therapy", date: "2026-11-30", time: "10:00" },
        },
      ]);
      expect(await rows(h, "events")).toEqual([
        expect.objectContaining({ startsOn: "2026-11-30", startTime: "10:00", repeatDays: [2] }),
      ]);
    });

    test("a clinic's late reminder for a past date of the series never says the calendar moved it", async () => {
      const h = await setup();
      const seriesId = await weeklyTherapy(h);
      const lastTuesday: JevSays = { ...THERAPY, when: { date: "2026-11-24", time: "10:00" } };
      const first = await triageEmail(h, clinic({ subject: "Reminder" }), lastTuesday);
      expect(first.effects).toEqual([{ kind: "already_on_calendar", eventId: seriesId }]);
      vi.setSystemTime(NOW + 7 * DAY);
      const late = await triageEmail(
        h,
        clinic({ subject: "Reminder", receivedAt: NOW + 7 * DAY - 30 * MINUTE }),
        lastTuesday,
      );
      expect(late.effects).toEqual([
        {
          kind: "escalated",
          reason: "unclear_appointment",
          pushed: true,
          proposed: { kind: "physical_therapy", date: "2026-11-24", time: "10:00" },
        },
      ]);
      const [post] = await rows(h, "chatPosts");
      expect(post!.body).toContain(
        "Sunny did not add this appointment because its date or time did not pass Sunny's checks: Physical therapy, Tuesday, November 24 at 10:00 AM.",
      );
      expect(post!.body).not.toContain("Sunny's calendar");
    });
  });

  test("a clinic's late reminder for a one-off that is over never says the calendar moved it", async () => {
    const h = await setup();
    const tomorrow: JevSays = { ...EYE_EXAM, when: { date: "2026-11-19", time: "10:00" } };
    const added = await triageEmail(h, clinic({ subject: "Confirmed" }), tomorrow);
    const [event] = await rows(h, "events");
    expect(added.effects?.[0]).toEqual({ kind: "event_added", eventId: event!._id });
    vi.setSystemTime(NOW + 2 * DAY);
    const late = await triageEmail(
      h,
      clinic({ subject: "Reminder", receivedAt: NOW + 2 * DAY - 30 * MINUTE }),
      tomorrow,
    );
    expect(late.effects).toEqual([
      {
        kind: "escalated",
        reason: "unclear_appointment",
        pushed: true,
        proposed: { kind: "eye_doctor", date: "2026-11-19", time: "10:00" },
      },
    ]);
    expect(await rows(h, "events")).toHaveLength(1);
    const post = (await rows(h, "chatPosts")).at(-1);
    expect(post!.body).toContain(
      "Sunny did not add this appointment because its date or time did not pass Sunny's checks: Eye exam, Thursday, November 19 at 10:00 AM.",
    );
    expect(post!.body).not.toContain("Sunny's calendar");
  });
});
