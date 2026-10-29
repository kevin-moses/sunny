// convex/sms.test.ts
// Purpose: Tests for the inbound SMS webhook (sms.ts) with convex-test and a stubbed global
// fetch (Twilio is never called). The webhook: signature valid, invalid, missing (checked before
// the body is read), signed for a different URL or token, 503 without the auth token or without
// TWILIO_WEBHOOK_URL (no default), STOP/HELP and unknown numbers get an empty response, a
// repeated MessageSid replays the stored reply and claims nothing twice, and the handled-text
// sweep. Claiming by reply: only the single newest alert actually texted (state sent, channel
// sms) in the last 24 hours is used, never an older one; open tasks are claimed (with the sms
// audit row), claimed ones say who is on it, closed ones say so; other kinds, unsent rows,
// other recipients, unverified numbers, viewers, a number shared across households, and many
// other rows after the alert; TwiML escaping of names.
//
// Last modified: 2026-10-29

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CLOSED_REPLY, HELP_REPLY, NOTHING_OPEN_REPLY, VIEWER_REPLY, parseCommand } from "./sms";
import {
  addInstance,
  createFamilyHousehold,
  createHousehold,
  makeBackend,
  setPhone,
} from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";
import { twilioSignature } from "./lib/twilio";

const START = Date.parse("2026-10-29T15:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const PAT_PHONE = "+15551110001";
const MAX_PHONE = "+15551110002";
const WEBHOOK_URL = "https://example.test/twilio/sms";

/** Counter so every post gets its own MessageSid unless a test reuses one. */
let sidCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15550009999");
  vi.stubEnv("TWILIO_WEBHOOK_URL", WEBHOOK_URL);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseCommand", () => {
  test.each([
    ["1", "claim"],
    [" 1 ", "claim"],
    ["On it", "claim"],
    ["ON IT!", "claim"],
    ["on it.", "claim"],
    ["STOP", "twilio_keyword"],
    ["stop", "twilio_keyword"],
    ["Help", "twilio_keyword"],
    ["unsubscribe", "twilio_keyword"],
    ["2", "other"],
    ["11", "other"],
    ["I'm on it", "other"],
    ["", "other"],
  ] as const)("%j is %s", (body, expected) => {
    expect(parseCommand(body)).toBe(expected);
  });
});

/** The household fixture: Pat (primary) and Max (member) with verified numbers, Val viewer. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
}

/**
 * purpose: Build the family household with Pat and Max's numbers verified.
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(): Promise<Fixture> {
  const t = makeBackend();
  const householdId = await createFamilyHousehold(t);
  await setPhone(t, householdId, "pat", PAT_PHONE);
  await setPhone(t, householdId, "max", MAX_PHONE, true, "Max");
  return { t, householdId };
}

/**
 * purpose: Queue an outbox row for a recipient at the current faked time.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param recipientUserId: (string) Recipient.
 * @param instanceId: (Id<"taskInstances">) Instance the alert is about.
 * @param kind: ("caregiver_alert" | "event_notice") Row kind.
 * @param delivery: (object) State and channel; defaults to texted (sent by sms).
 * @return: (Promise<void>)
 */
async function addAlert(
  t: TestConvex,
  householdId: Id<"households">,
  recipientUserId: string,
  instanceId: Id<"taskInstances">,
  kind: "caregiver_alert" | "event_notice" = "caregiver_alert",
  delivery: Pick<Doc<"notificationOutbox">, "state" | "channel"> = {
    state: "sent",
    channel: "sms",
  },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("notificationOutbox", {
      householdId,
      kind,
      taskInstanceId: instanceId,
      recipientUserId,
      title: "alert",
      body: "alert",
      payload: {},
      ...delivery,
    });
  });
}

/**
 * purpose: POST to /twilio/sms as Twilio would.
 * @param t: (TestConvex) Harness.
 * @param from: (string) Sender number.
 * @param body: (string) Message text.
 * @param options: ({sign, signedUrl, signature, sid}) sign false omits the header; signedUrl is
 *        the URL the signature covers; signature overrides the computed value; sid is the
 *        MessageSid (a fresh one per post by default).
 * @return: (Promise<Response>) The response.
 */
async function post(
  t: TestConvex,
  from: string,
  body: string,
  options: { sign?: boolean; signedUrl?: string; signature?: string; sid?: string } = {},
): Promise<Response> {
  sidCounter += 1;
  const params = new URLSearchParams({
    From: from,
    To: "+15550009999",
    Body: body,
    MessageSid: options.sid ?? `SM${sidCounter}`,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (options.sign !== false) {
    headers["X-Twilio-Signature"] =
      options.signature ?? (await twilioSignature(options.signedUrl ?? WEBHOOK_URL, params, "tok"));
  }
  return await t.fetch("/twilio/sms", { method: "POST", headers, body: params.toString() });
}

/**
 * purpose: The text of the single <Message> in a TwiML response.
 * @param response: (Response) The webhook response.
 * @return: (Promise<string | null>) The raw (still escaped) message text, or null if none.
 */
async function messageOf(response: Response): Promise<string | null> {
  const xml = await response.text();
  return /<Message>(.*)<\/Message>/.exec(xml)?.[1] ?? null;
}

/**
 * purpose: Who has claimed an instance.
 * @param t: (TestConvex) Harness.
 * @param id: (Id<"taskInstances">) Instance.
 * @return: (Promise<string | undefined>) The claimant's user id.
 */
async function claimedBy(t: TestConvex, id: Id<"taskInstances">): Promise<string | undefined> {
  return (await t.run(async (ctx) => (await ctx.db.get(id))?.claimedBy ?? null)) ?? undefined;
}

describe("inbound webhook signature", () => {
  test("a valid signature gets a 200 TwiML reply", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    const response = await post(t, PAT_PHONE, "1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/xml");
    expect(await response.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Thanks, Pat. You&apos;re on it: Morning pills for Mom.</Message></Response>',
    );
  });

  test("a missing signature is 403 and nothing is claimed", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    const response = await post(t, PAT_PHONE, "1", { sign: false });
    expect(response.status).toBe(403);
    expect(await claimedBy(t, id)).toBeUndefined();
  });

  test("an invalid signature is 403 and nothing is claimed", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    const response = await post(t, PAT_PHONE, "1", { signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(response.status).toBe(403);
    expect(await claimedBy(t, id)).toBeUndefined();
  });

  test("a signature made for a different URL is 403", async () => {
    const { t } = await setup();
    const response = await post(t, PAT_PHONE, "1", {
      signedUrl: "https://enduring-ostrich-959.convex.site/twilio/sms/",
    });
    expect(response.status).toBe(403);
  });

  test("a signature made with a different token is 403", async () => {
    const { t } = await setup();
    vi.stubEnv("TWILIO_AUTH_TOKEN", "rotated");
    const response = await post(t, PAT_PHONE, "1");
    expect(response.status).toBe(403);
  });

  test("TWILIO_WEBHOOK_URL is the URL the signature must cover", async () => {
    const { t } = await setup();
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.test/hook");
    expect((await post(t, PAT_PHONE, "1")).status).toBe(403);
    expect((await post(t, PAT_PHONE, "1", { signedUrl: "https://example.test/hook" })).status).toBe(
      200,
    );
  });

  test("without an auth token the webhook is 503", async () => {
    const { t } = await setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    expect((await post(t, PAT_PHONE, "1")).status).toBe(503);
    errorSpy.mockRestore();
  });

  test("without TWILIO_WEBHOOK_URL the webhook is 503 and logs why", async () => {
    const { t } = await setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("TWILIO_WEBHOOK_URL", "");
    expect((await post(t, PAT_PHONE, "1")).status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("TWILIO_WEBHOOK_URL"));
    errorSpy.mockRestore();
  });

  test("a repeated MessageSid replays the reply and claims nothing again", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    const first = await messageOf(await post(t, PAT_PHONE, "1", { sid: "SMdup" }));
    const second = await messageOf(await post(t, PAT_PHONE, "1", { sid: "SMdup" }));
    expect(first).toContain("Thanks, Pat");
    expect(second).toBe(first);
    const claims = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((r) => r.action === "claim_via"),
    );
    expect(claims).toHaveLength(1);
  });

  test("a different MessageSid is handled separately", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    await post(t, PAT_PHONE, "1", { sid: "SMa" });
    expect(await messageOf(await post(t, PAT_PHONE, "1", { sid: "SMb" }))).toContain(
      "already on it",
    );
  });

  test("sweepInbound deletes handled-text records past their expiry only", async () => {
    const { t } = await setup();
    await post(t, PAT_PHONE, "hello", { sid: "SMold" });
    vi.setSystemTime(START + 25 * HOUR_MS);
    await post(t, PAT_PHONE, "hello", { sid: "SMnew" });
    expect(await t.mutation(internal.sms.sweepInbound, {})).toBe(1);
    const left = await t.run(async (ctx) => await ctx.db.query("smsInbound").collect());
    expect(left.map((r) => r.messageSid)).toEqual(["SMnew"]);
  });

  test("STOP and HELP get an empty response and claim nothing", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    for (const word of ["STOP", "help", "Unsubscribe"]) {
      const response = await post(t, PAT_PHONE, word);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      );
    }
    expect(await claimedBy(t, id)).toBeUndefined();
  });
});

describe("claiming by reply", () => {
  test("claims the open task as the sender and audits the claim as sms", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    const reply = await messageOf(await post(t, PAT_PHONE, "1"));
    expect(reply).toBe("Thanks, Pat. You&apos;re on it: Morning pills for Mom.");
    expect(await claimedBy(t, id)).toBe("pat");
    const rows = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    const claim = rows.find((r) => r.action === "claim" && r.entityId === id);
    const via = rows.find((r) => r.action === "claim_via" && r.entityId === id);
    expect(claim).toMatchObject({ actorUserId: "pat", actorKind: "caregiver" });
    expect(via).toMatchObject({ actorUserId: "pat", detail: { via: "sms" } });
  });

  test('"on it" in any case, with punctuation, claims', async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    expect(await messageOf(await post(t, PAT_PHONE, "  ON It! "))).toContain(
      "on it: Morning pills",
    );
    expect(await claimedBy(t, id)).toBe("pat");
  });

  test("the newest alert wins when several tasks are open", async () => {
    const { t, householdId } = await setup();
    const older = await addInstance(t, householdId, "Morning pills");
    const newer = await addInstance(t, householdId, "Evening pills");
    await addAlert(t, householdId, "pat", older);
    vi.setSystemTime(START + HOUR_MS);
    await addAlert(t, householdId, "pat", newer);
    vi.setSystemTime(START + 2 * HOUR_MS);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toContain("Evening pills");
    expect(await claimedBy(t, newer)).toBe("pat");
    expect(await claimedBy(t, older)).toBeUndefined();
    // A second reply is about the same newest alert; the older one is never used instead.
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toContain("already on it, Pat");
    expect(await claimedBy(t, older)).toBeUndefined();
  });

  test("a closed newest alert is reported closed and never falls through to an older one", async () => {
    const { t, householdId } = await setup();
    const open = await addInstance(t, householdId, "Morning pills");
    const done = await addInstance(t, householdId, "Evening pills", { state: "confirmed" });
    await addAlert(t, householdId, "pat", open);
    vi.setSystemTime(START + HOUR_MS);
    await addAlert(t, householdId, "pat", done);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      `${CLOSED_REPLY}: Evening pills for Mom.`,
    );
    expect(await claimedBy(t, open)).toBeUndefined();
  });

  test("alerts that were never texted do not count", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id, "caregiver_alert", { state: "pending" });
    await addAlert(t, householdId, "pat", id, "caregiver_alert", { state: "failed" });
    await addAlert(t, householdId, "pat", id, "caregiver_alert", { state: "skipped" });
    await addAlert(t, householdId, "pat", id, "caregiver_alert", {
      state: "sent",
      channel: "apns",
    });
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      NOTHING_OPEN_REPLY.replace(/'/g, "&apos;"),
    );
    expect(await claimedBy(t, id)).toBeUndefined();
  });

  test("many other rows after the alert do not hide it", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    for (let i = 0; i < 60; i++) await addAlert(t, householdId, "pat", id, "event_notice");
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toContain("on it: Morning pills");
  });

  test("a repeated alert row for one instance claims it once", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills", { state: "due" });
    await addAlert(t, householdId, "pat", id);
    await addAlert(t, householdId, "pat", id);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toContain("You&apos;re on it");
    expect(await claimedBy(t, id)).toBe("pat");
  });

  test("an instance claimed by someone else names who", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills", { claimedBy: "max" });
    await addAlert(t, householdId, "pat", id);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      "Max is already on it: Morning pills for Mom.",
    );
    expect(await claimedBy(t, id)).toBe("max");
  });

  test("an instance the sender already claimed says so", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills", { claimedBy: "pat" });
    await addAlert(t, householdId, "pat", id);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      "You&apos;re already on it, Pat: Morning pills for Mom.",
    );
  });

  test("a second reply after claiming reports already on it", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    await post(t, PAT_PHONE, "1");
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toContain("already on it");
  });

  test("nothing open gets the short help text", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills", { state: "confirmed" });
    await addAlert(t, householdId, "pat", id);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      `${CLOSED_REPLY}: Morning pills for Mom.`,
    );
  });

  test("a member who was never alerted gets the nothing-open reply", async () => {
    const { t } = await setup();
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      NOTHING_OPEN_REPLY.replace(/'/g, "&apos;"),
    );
  });

  test("alerts older than 24 hours are ignored", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    vi.setSystemTime(START + 24 * HOUR_MS + 60_000);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      NOTHING_OPEN_REPLY.replace(/'/g, "&apos;"),
    );
    expect(await claimedBy(t, id)).toBeUndefined();
  });

  test("an alert just inside 24 hours still counts", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    vi.setSystemTime(START + 24 * HOUR_MS - 60_000);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toContain("on it: Morning pills");
  });

  test("an alert sent to someone else does not let the sender claim", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "max", id);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      NOTHING_OPEN_REPLY.replace(/'/g, "&apos;"),
    );
    expect(await claimedBy(t, id)).toBeUndefined();
  });

  test("an event notice is not an alert", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id, "event_notice");
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      NOTHING_OPEN_REPLY.replace(/'/g, "&apos;"),
    );
  });

  test.each(["upcoming", "missed", "resolved"] as const)(
    "an instance in state %s is not claimable by reply",
    async (state) => {
      const { t, householdId } = await setup();
      const id = await addInstance(t, householdId, "Morning pills", { state });
      await addAlert(t, householdId, "pat", id);
      expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
        `${CLOSED_REPLY}: Morning pills for Mom.`,
      );
      expect(await claimedBy(t, id)).toBeUndefined();
    },
  );

  test("an unverified number is treated as unknown and claims nothing", async () => {
    const { t, householdId } = await setup();
    await setPhone(t, householdId, "pat", PAT_PHONE, false);
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBeNull();
    expect(await claimedBy(t, id)).toBeUndefined();
  });

  test("an unknown number gets an empty response and no household data", async () => {
    const { t, householdId } = await setup();
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "pat", id);
    const response = await post(t, "+15559998888", "1");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
    expect(await messageOf(await post(t, "+15559998888", "hello"))).toBeNull();
  });

  test("a malformed From is treated as unknown", async () => {
    const { t } = await setup();
    expect(await messageOf(await post(t, "not-a-number", "1"))).toBeNull();
  });

  test("a viewer cannot claim", async () => {
    const { t, householdId } = await setup();
    await setPhone(t, householdId, "val", "+15551110003");
    const id = await addInstance(t, householdId, "Morning pills");
    await addAlert(t, householdId, "val", id);
    expect(await messageOf(await post(t, "+15551110003", "1"))).toBe(VIEWER_REPLY);
    expect(await claimedBy(t, id)).toBeUndefined();
  });

  test("other text from a member gets the help reply", async () => {
    const { t } = await setup();
    expect(await messageOf(await post(t, PAT_PHONE, "what is this"))).toBe(
      HELP_REPLY.replace(/'/g, "&apos;"),
    );
  });

  test("a number in two households claims the newest alert across them", async () => {
    const { t, householdId } = await setup();
    const second = await createHousehold(t, {
      subject: "pat",
      seniorName: "Dad",
      caregiverName: "Patricia",
    });
    await setPhone(t, second, "pat", PAT_PHONE);
    const inFirst = await addInstance(t, householdId, "Morning pills");
    const inSecond = await addInstance(t, second, "Insulin");
    await addAlert(t, householdId, "pat", inFirst);
    vi.setSystemTime(START + HOUR_MS);
    await addAlert(t, second, "pat", inSecond);
    vi.setSystemTime(START + 2 * HOUR_MS);
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      "Thanks, Patricia. You&apos;re on it: Insulin for Dad.",
    );
    expect(await claimedBy(t, inSecond)).toBe("pat");
    expect(await claimedBy(t, inFirst)).toBeUndefined();
    // The older alert in the other household is not used once the newest is taken.
    expect(await messageOf(await post(t, PAT_PHONE, "1"))).toBe(
      "You&apos;re already on it, Patricia: Insulin for Dad.",
    );
    expect(await claimedBy(t, inFirst)).toBeUndefined();
  });

  test("escapes XML characters in names and labels", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t, {
      subject: "anna",
      seniorName: "Tom & <Jerry>",
      caregiverName: 'Anna "A" <b>',
    });
    await setPhone(t, householdId, "anna", PAT_PHONE);
    const id = await addInstance(t, householdId, "Pills & <drops>");
    await addAlert(t, householdId, "anna", id);
    const response = await post(t, PAT_PHONE, "1");
    const xml = await response.text();
    expect(xml).toContain(
      "Thanks, Anna &quot;A&quot; &lt;b&gt;. You&apos;re on it: Pills &amp; &lt;drops&gt; for Tom &amp; &lt;Jerry&gt;.",
    );
    expect(xml).not.toContain("<b>");
    expect(xml).not.toContain("<Jerry>");
    expect((xml.match(/<Message>/g) ?? []).length).toBe(1);
  });
});
