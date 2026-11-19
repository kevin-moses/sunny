import { NonRetryableError, vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { mailFailure } from "./gmail";
import { postMail } from "./lib/chatPosts";
import { errorText } from "./lib/errors";
import { getMessage, hasSentTo } from "./lib/gmailApi";
import { AccessTokens } from "./lib/googleTokens";
import type { StoredGrant } from "./lib/googleTokens";
import { haikuClassifier, triageEmail } from "./lib/mailClassify";
import { carryOut, linkByKey, linkForEvent } from "./lib/mailEffects";
import { parseGmailMessage } from "./lib/mailParse";
import { caregiverText, linkKey, planWithRule } from "./lib/mailPolicy";
import type { CalendarEventFact, MailVerdict, PolicyFacts, Triaged } from "./lib/mailTypes";
import { TRIAGE_PICKUP_MS, enqueueTriage } from "./lib/mailPool";
import { expandOccurrences, liveEvents } from "./lib/occurrences";
import { MINUTE_MS, addDays, localDate } from "./lib/time";
import { icsEvent, mailSender, triaged as triagedValidator } from "./lib/validators";
import type { ClassifierRecord, StoredSender, StoredVerdict } from "./lib/validators";

export const MAX_TRIAGE_ATTEMPTS = 10;
const LEASE_MS = 10 * MINUTE_MS;
const EVENT_HORIZON_DAYS = 400;
const SWEEP_BATCH = 100;
const MAX_NAME = 120;
const MAX_ADDRESS = 320;
const MAX_SUBJECT = 200;
const MAX_SUMMARY = 600;
const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

type Claim =
  | { kind: "skip"; reason: string }
  | {
      kind: "claimed";
      attempt: number;
      gmailId: string;
      mailboxId: Id<"mailboxes">;
      timezone: string;
      now: number;
      grant: StoredGrant;
    };

type TriageOutcome = "skipped" | "gone" | "unparseable" | "applied" | "lost" | "mailbox_lost";

const mailHeader = v.object({
  sender: mailSender,
  subject: v.string(),
  receivedAt: v.number(),
});

const unreadRule = v.union(v.literal("gone"), v.literal("unparseable"));

type MailHeader = Infer<typeof mailHeader>;

function holdsClaim(item: Doc<"mailItems"> | null, attempt: number): item is Doc<"mailItems"> {
  return item !== null && item.state === "triaging" && item.attempt === attempt;
}

function clip(text: string, max: number): string {
  return text.slice(0, max);
}

function storedHeader(header: MailHeader): {
  sender: StoredSender;
  subject: string;
  receivedAt: number;
} {
  const { sender } = header;
  return {
    sender: {
      name: clip(sender.name, MAX_NAME),
      address: clip(sender.address, MAX_ADDRESS),
      authenticated: sender.authenticated,
      known: sender.known,
    },
    subject: clip(header.subject, MAX_SUBJECT),
    receivedAt: header.receivedAt,
  };
}

function storedVerdict(verdict: MailVerdict | null): StoredVerdict {
  if (verdict === null) return { kind: "unreadable", summary: "" };
  return { kind: verdict.kind, summary: clip(verdict.summary, MAX_SUMMARY) };
}

function classifierOf(triaged: Triaged): ClassifierRecord {
  return triaged.stage === "gate"
    ? { name: `gate:${triaged.rule}`, usage: NO_USAGE }
    : { name: triaged.classifier, usage: triaged.usage };
}

async function mailboxOf(ctx: QueryCtx, item: Doc<"mailItems">): Promise<Doc<"mailboxes"> | null> {
  const mailbox = await ctx.db
    .query("mailboxes")
    .withIndex("by_household", (q) => q.eq("householdId", item.householdId))
    .unique();
  return mailbox?.accountEmail === item.account ? mailbox : null;
}

async function waitsToBeClaimed(ctx: QueryCtx, item: Doc<"mailItems">): Promise<boolean> {
  const household = await ctx.db.get(item.householdId);
  if (household?.backgroundPaused) return true;
  const mailbox = await mailboxOf(ctx, item);
  return mailbox !== null && mailbox.status !== "active";
}

export const claimItem = internalMutation({
  args: { itemId: v.id("mailItems") },
  handler: async (ctx, { itemId }): Promise<Claim> => {
    const item = await ctx.db.get(itemId);
    if (!item || item.state !== "queued") return { kind: "skip", reason: "not queued" };
    const household = await ctx.db.get(item.householdId);
    if (household?.backgroundPaused) return { kind: "skip", reason: "household paused" };
    const mailbox = await mailboxOf(ctx, item);
    if (!household || !mailbox) {
      await ctx.db.patch(itemId, { state: "failed", leaseUntil: undefined });
      return { kind: "skip", reason: "mailbox gone" };
    }
    if (mailbox.status !== "active") return { kind: "skip", reason: "mailbox not active" };
    if (item.attempt >= MAX_TRIAGE_ATTEMPTS) {
      await failUnread(ctx, item);
      return { kind: "skip", reason: "attempts used up" };
    }
    const now = Date.now();
    const attempt = item.attempt + 1;
    await ctx.db.patch(itemId, { state: "triaging", attempt, leaseUntil: now + LEASE_MS });
    return {
      kind: "claimed",
      attempt,
      gmailId: item.gmailId,
      mailboxId: mailbox._id,
      timezone: household.timezone,
      now,
      grant: {
        refreshToken: mailbox.refreshToken,
        accessToken: mailbox.accessToken ?? null,
        accessTokenExpiresAt: mailbox.accessTokenExpiresAt ?? null,
      },
    };
  },
});

export const releaseClaim = internalMutation({
  args: { itemId: v.id("mailItems"), attempt: v.number() },
  handler: async (ctx, { itemId, attempt }): Promise<null> => {
    if (holdsClaim(await ctx.db.get(itemId), attempt)) {
      await ctx.db.patch(itemId, { state: "queued", leaseUntil: Date.now() + TRIAGE_PICKUP_MS });
    }
    return null;
  },
});

export const closeUnread = internalMutation({
  args: { itemId: v.id("mailItems"), attempt: v.number(), rule: unreadRule },
  handler: async (ctx, { itemId, attempt, rule }): Promise<boolean> => {
    if (!holdsClaim(await ctx.db.get(itemId), attempt)) return false;
    await ctx.db.patch(itemId, { state: "done", leaseUntil: undefined, rule, effects: [] });
    return true;
  },
});

export const recordParsed = internalMutation({
  args: {
    itemId: v.id("mailItems"),
    attempt: v.number(),
    ...mailHeader.fields,
    icsKey: v.union(v.null(), v.string()),
  },
  handler: async (
    ctx,
    { itemId, attempt, icsKey, ...header },
  ): Promise<{ knownIcsUid: boolean } | null> => {
    const item = await ctx.db.get(itemId);
    if (!holdsClaim(item, attempt)) return null;
    await ctx.db.patch(itemId, storedHeader(header));
    const link = icsKey === null ? null : await linkByKey(ctx, item.householdId, icsKey);
    return { knownIcsUid: link !== null };
  },
});

async function eventFact(
  ctx: QueryCtx,
  event: Doc<"events">,
  date: string,
): Promise<CalendarEventFact> {
  const link = await linkForEvent(ctx, event._id);
  const source = link === null ? null : await ctx.db.get(link.mailItemId);
  return {
    eventId: event._id,
    title: event.title,
    date,
    time: event.startTime,
    durationMinutes: event.durationMinutes ?? null,
    repeating: event.repeatDays !== undefined,
    sourceSender: source?.sender?.address ?? null,
  };
}

function datesNamed(verdict: MailVerdict | null): string[] {
  if (verdict?.kind !== "appointment") return [];
  if (verdict.change === "cancel") return [verdict.previous.date];
  const { date } = verdict.appointment;
  const dates = [addDays(date, -1), date];
  return verdict.change === "reschedule" ? [...dates, verdict.previous.date] : dates;
}

async function calendarFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
  verdict: MailVerdict | null,
): Promise<{ events: Doc<"events">[]; facts: CalendarEventFact[] }> {
  const today = localDate(now, household.timezone);
  const last = addDays(today, EVENT_HORIZON_DAYS);
  const inHorizon = (date: string) => date >= today && date <= last;
  const live = await liveEvents(ctx, household._id);
  const singles = live.filter((e) => e.repeatDays === undefined && inHorizon(e.startsOn));
  const series = live.filter((e) => e.repeatDays !== undefined);
  const occurrences = [...new Set(datesNamed(verdict).filter(inHorizon))].flatMap((date) =>
    expandOccurrences(series, household.timezone, date, date),
  );
  const facts = await Promise.all([
    ...singles.map((e) => eventFact(ctx, e, e.startsOn)),
    ...occurrences.map((o) => eventFact(ctx, o.event, o.localDate)),
  ]);
  return { events: [...singles, ...series], facts };
}

export const applyTriage = internalMutation({
  args: {
    itemId: v.id("mailItems"),
    attempt: v.number(),
    email: v.object({ ...mailHeader.fields, ics: v.union(v.null(), icsEvent) }),
    triaged: triagedValidator,
  },
  handler: async (ctx, { itemId, attempt, email, triaged }): Promise<boolean> => {
    const item = await ctx.db.get(itemId);
    if (!holdsClaim(item, attempt)) return false;
    const household = await ctx.db.get(item.householdId);
    if (!household) {
      await ctx.db.patch(itemId, { state: "failed", leaseUntil: undefined });
      return false;
    }
    const now = Date.now();
    const calendar = await calendarFacts(ctx, household, now, triaged.verdict);
    const events = new Map<string, Doc<"events">>(calendar.events.map((e) => [e._id, e]));
    const key = linkKey(triaged.verdict, email.ics);
    const link = key === null ? null : await linkByKey(ctx, household._id, key);
    const linked = link === null ? null : await ctx.db.get(link.eventId);
    if (linked !== null) events.set(linked._id, linked);
    const header = storedHeader(email);
    const facts: PolicyFacts = {
      now,
      timezone: household.timezone,
      sender: header.sender,
      senderKnown: header.sender.known,
      subject: header.subject,
      receivedAt: header.receivedAt,
      gmailId: item.gmailId,
      ics: email.ics,
      events: calendar.facts,
      linkedEventId: linked?._id ?? null,
    };
    const plan = planWithRule(triaged, facts);
    const effects = await carryOut(
      {
        ctx,
        household,
        item,
        facts,
        events,
        linkKey: key,
        summary: triaged.verdict?.summary ?? "",
      },
      plan.effects,
    );
    await ctx.db.patch(itemId, {
      ...header,
      state: "done",
      leaseUntil: undefined,
      verdict: storedVerdict(triaged.verdict),
      rule: plan.rule,
      effects,
      escalatedAt: effects.some((e) => e.kind === "escalated") ? now : undefined,
      classifier: classifierOf(triaged),
    });
    return true;
  },
});

async function settleTriageError(
  ctx: ActionCtx,
  itemId: Id<"mailItems">,
  claim: Extract<Claim, { kind: "claimed" }>,
  e: unknown,
): Promise<TriageOutcome> {
  const failure = mailFailure(e);
  if (failure.kind === "permanent") throw new NonRetryableError(errorText(e), { cause: e });
  if (failure.kind === "mailbox") {
    await ctx.runMutation(internal.gmail.markMailbox, {
      mailboxId: claim.mailboxId,
      status: failure.status,
      error: failure.error,
    });
  }
  await ctx.runMutation(internal.mailTriage.releaseClaim, { itemId, attempt: claim.attempt });
  if (failure.kind === "mailbox") return "mailbox_lost";
  throw e;
}

async function triageClaimed(
  ctx: ActionCtx,
  itemId: Id<"mailItems">,
  claim: Extract<Claim, { kind: "claimed" }>,
  tokens: AccessTokens,
): Promise<TriageOutcome> {
  const { attempt, timezone } = claim;
  const raw = await tokens.withToken((token) => getMessage(token, claim.gmailId));
  const email = raw === null ? null : parseGmailMessage(raw, timezone);
  if (email === null) {
    const rule = raw === null ? "gone" : "unparseable";
    await ctx.runMutation(internal.mailTriage.closeUnread, { itemId, attempt, rule });
    return rule;
  }
  const known = await tokens.withToken((token) => hasSentTo(token, email.sender.address));
  const header = {
    sender: { ...email.sender, known },
    subject: email.subject,
    receivedAt: email.receivedAt,
  };
  const parsed = await ctx.runMutation(internal.mailTriage.recordParsed, {
    itemId,
    attempt,
    ...header,
    icsKey: linkKey(null, email.ics),
  });
  if (parsed === null) return "lost";
  const triaged = await triageEmail(
    email,
    { now: claim.now, timezone },
    haikuClassifier,
    parsed.knownIcsUid,
  );
  const applied = await ctx.runMutation(internal.mailTriage.applyTriage, {
    itemId,
    attempt,
    email: { ...header, ics: email.ics },
    triaged,
  });
  return applied ? "applied" : "lost";
}

export const triage = internalAction({
  args: { itemId: v.id("mailItems") },
  handler: async (ctx, { itemId }): Promise<TriageOutcome> => {
    const claim: Claim = await ctx.runMutation(internal.mailTriage.claimItem, { itemId });
    if (claim.kind === "skip") return "skipped";
    const tokens = await new AccessTokens(claim.grant, async (accessToken, expiresAt) => {
      await ctx.runMutation(internal.gmail.saveMailboxToken, {
        mailboxId: claim.mailboxId,
        accessToken,
        expiresAt,
      });
    }).load();
    try {
      return await triageClaimed(ctx, itemId, claim, tokens);
    } catch (e) {
      return await settleTriageError(ctx, itemId, claim, e);
    }
  },
});

async function failUnread(ctx: MutationCtx, item: Doc<"mailItems">): Promise<void> {
  await ctx.db.patch(item._id, { state: "failed", leaseUntil: undefined });
  const household = await ctx.db.get(item.householdId);
  if (household) {
    const now = Date.now();
    await postMail(ctx, household, item._id, unreadPost(item, household, now), now);
  }
}

function unreadPost(item: Doc<"mailItems">, household: Doc<"households">, now: number): string {
  const { sender, subject, receivedAt } = item;
  if (sender === undefined || subject === undefined || receivedAt === undefined) {
    return "Sunny could not read an email. Please look at the inbox in Gmail.";
  }
  return caregiverText(
    {
      now,
      timezone: household.timezone,
      sender,
      senderKnown: sender.known,
      subject,
      receivedAt,
      gmailId: item.gmailId,
      ics: null,
      events: [],
      linkedEventId: null,
    },
    ["Sunny could not read an email. Please look at it in Gmail."],
  );
}

export const onMailJobComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ itemId: v.id("mailItems") })),
  handler: async (ctx, { workId, context, result }): Promise<null> => {
    if (result.kind !== "failed") return null;
    const item = await ctx.db.get(context.itemId);
    if (!item || item.jobId !== workId) return null;
    if (item.state !== "queued" && item.state !== "triaging") return null;
    console.error(`Mail triage failed: ${result.error}`);
    await failUnread(ctx, item);
    return null;
  },
});

async function requeueOverdue(
  ctx: MutationCtx,
  state: "queued" | "triaging",
  now: number,
): Promise<number> {
  const rows = await ctx.db
    .query("mailItems")
    .withIndex("by_state_lease", (q) => q.eq("state", state).lt("leaseUntil", now))
    .take(SWEEP_BATCH);
  let queued = 0;
  for (const row of rows) {
    await ctx.db.patch(row._id, { state: "queued", leaseUntil: now + TRIAGE_PICKUP_MS });
    if (await waitsToBeClaimed(ctx, row)) continue;
    await enqueueTriage(ctx, row._id);
    queued += 1;
  }
  return queued;
}

export const sweepStuck = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    return (
      (await requeueOverdue(ctx, "triaging", now)) + (await requeueOverdue(ctx, "queued", now))
    );
  },
});
