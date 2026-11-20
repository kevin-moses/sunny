import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildBriefing } from "./lib/agentBriefing";
import {
  DEFAULT_SUMMARY,
  item,
  jevCalls,
  jevSays,
  receive,
  rows,
  summaryCalls,
  triageEmail,
} from "./mailMocks.helpers";
import {
  DELIVERY,
  EYE_EXAM,
  NOW,
  PHISHING,
  clinic,
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

describe("the caregiver summary", () => {
  test("a caregiver post carries Haiku's summary; pushes, notes, events and the briefing never do", async () => {
    const h = await setup();
    jevSays(PHISHING, "Someone signing as Tom asks for gift cards to pay bail.");
    const done = await triageEmail(
      h,
      clinic({ from: "Grandson Tom <tom@example.org>", subject: "Grandma help" }),
    );
    expect(summaryCalls).toHaveLength(1);
    expect(JSON.stringify(summaryCalls[0])).toContain("<email>");
    const [post] = await rows(h, "chatPosts");
    expect(post!.body.split("\n")).toEqual([
      "Sunny thinks this email may be a scam and did not tell the senior about it.",
      "Someone signing as Tom asks for gift cards to pay bail.",
    ]);
    for (const push of await rows(h, "notificationOutbox")) {
      expect(push.body).not.toContain("gift cards");
    }
    const briefing = await h.t.run(
      async (ctx) => await buildBriefing(ctx, h.householdId, "pat", NOW),
    );
    expect(briefing).toContain(`money_request; mail_item_id ${done._id}`);
    expect(briefing).not.toContain("gift cards");
  });

  test("is not asked for when Sunny posts nothing to the caregivers", async () => {
    const h = await setup();
    await triageEmail(h, clinic({ from: "Northgate <rx@northgate.example>" }), DELIVERY);
    await triageEmail(h, clinic(), { yes: ["receipt"] });
    await triageEmail(h, clinic({ labels: ["INBOX", "CATEGORY_PROMOTIONS"] }));
    expect(summaryCalls).toHaveLength(0);
    expect(await rows(h, "chatPosts")).toHaveLength(0);
  });

  test("a failed summary falls back to Sunny's sentence and the triage still finishes", async () => {
    const h = await setup();
    jevSays(PHISHING, { status: 500 });
    const done = await triageEmail(h, clinic());
    expect(done.state).toBe("done");
    expect((await rows(h, "chatPosts"))[0]!.body.split("\n")).toEqual([
      "Sunny thinks this email may be a scam and did not tell the senior about it.",
      "The email asks for money by gift card, wire transfer, cash or another hard-to-trace way.",
    ]);
  });

  test("the plan is made once, before Haiku writes, so a calendar change meanwhile changes nothing", async () => {
    const h = await setup();
    const seen: { state?: string; post?: string[] } = {};
    jevSays(EYE_EXAM, DEFAULT_SUMMARY, async () => {
      const [during] = await h.t.run(async (ctx) => await ctx.db.query("mailItems").collect());
      seen.state = during!.state;
      seen.post = (await rows(h, "chatPosts"))[0]!.body.split("\n");
      await insertEvent(h.t, h.householdId, {
        title: "Lunch with Ruth",
        startsOn: "2026-12-10",
        startTime: "14:00",
        durationMinutes: 60,
      });
    });
    const done = await triageEmail(h, clinic());
    expect(seen.state).toBe("done");
    expect(seen.post).toEqual([
      "Sunny added Eye exam, Thursday, December 10 at 2:15 PM, to the calendar.",
      expect.not.stringContaining(DEFAULT_SUMMARY),
    ]);
    expect(kinds(done.effects ?? [])).toEqual(["event_added", "told_caregivers"]);
    expect(done.rule).toBe("new-add");
    expect(jevCalls).toHaveLength(1);
    expect(summaryCalls).toHaveLength(1);
    const [post] = await rows(h, "chatPosts");
    expect(post!.body.split("\n")).toEqual([seen.post![0], DEFAULT_SUMMARY]);
    expect(done.caregiverPost).toEqual({ postId: post!._id, line: seen.post![0] });
  });

  test("a post deleted while Haiku writes stays deleted", async () => {
    const h = await setup();
    jevSays(PHISHING, DEFAULT_SUMMARY, async () => {
      await h.t.run(async (ctx) => {
        for (const post of await ctx.db.query("chatPosts").collect()) await ctx.db.delete(post._id);
      });
    });
    const itemId = await receive(h, clinic());
    expect(await h.t.action(internal.mailTriage.triage, { itemId })).toBe("applied");
    expect(summaryCalls).toHaveLength(1);
    expect(await rows(h, "chatPosts")).toHaveLength(0);
    expect((await item(h, itemId)).state).toBe("done");
  });

  test("a summary for another claim, or for a post of another email, changes nothing", async () => {
    const h = await setup();
    jevSays(PHISHING);
    const first = await triageEmail(h, clinic());
    const second = await triageEmail(h, clinic({ subject: "Grandma help" }));
    const replace = (itemId: Id<"mailItems">, attempt: number) =>
      h.t.mutation(internal.mailTriage.replaceSummary, {
        itemId,
        attempt,
        ics: null,
        summary: "A later summary.",
      });
    const bodies = async () => (await rows(h, "chatPosts")).map((p) => p.body);
    const before = await bodies();

    expect(await replace(first._id, first.attempt - 1)).toBe(false);
    expect(await replace(first._id, first.attempt + 1)).toBe(false);
    await h.t.run(
      async (ctx) =>
        await ctx.db.patch(first._id, {
          caregiverPost: { ...first.caregiverPost!, postId: second.caregiverPost!.postId },
        }),
    );
    expect(await replace(first._id, first.attempt)).toBe(false);
    expect(await bodies()).toEqual(before);

    expect(await replace(second._id, second.attempt)).toBe(true);
    expect((await bodies())[1]).toContain("A later summary.");
  });

  test("a summary that times out falls back to Sunny's sentence", async () => {
    const h = await setup();
    jevSays(PHISHING, "hang");
    const itemId = await receive(h, clinic());
    const triage = h.t.action(internal.mailTriage.triage, { itemId });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await triage).toBe("applied");
    expect((await rows(h, "chatPosts"))[0]!.body).toContain(
      "The email asks for money by gift card, wire transfer, cash or another hard-to-trace way.",
    );
  });
});
