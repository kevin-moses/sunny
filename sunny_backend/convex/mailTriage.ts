import { NonRetryableError, vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { tokensFor } from "./googleGrant";
import { postMail } from "./lib/chatPosts";
import { errorText } from "./lib/errors";
import { getMessage } from "./lib/gmailApi";
import { storedGrant } from "./lib/googleTokens";
import type { AccessTokens, StoredGrant } from "./lib/googleTokens";
import { carryOut, senderLink } from "./lib/mailEffects";
import { mailFailure } from "./lib/mailFailure";
import { askJev, triageEmail } from "./lib/mailJudge";
import { parseGmailMessage } from "./lib/mailParse";
import {
  MAX_CALENDAR_CHANGES_PER_DAY,
  caregiverText,
  factsCover,
  linkKey,
  planWithRule,
} from "./lib/mailPolicy";
import type {
  CalendarEventFact,
  KnownInvite,
  LinkedEvent,
  MailSender,
  MailVerdict,
  PolicyFacts,
} from "./lib/mailTypes";
import { TRIAGE_PICKUP_MS, enqueueTriage } from "./lib/mailPool";
import { summarizeForCaregivers } from "./lib/mailSummary";
import { canStillOccur, expandOccurrences, liveEvents } from "./lib/occurrences";
import { MINUTE_MS, addDays, localDate, localMidnight } from "./lib/time";
import { icsEvent, mailSender, triaged as triagedValidator } from "./lib/validators";

export const MAX_TRIAGE_ATTEMPTS = 10;
const LEASE_MS = 10 * MINUTE_MS;
const SWEEP_BATCH = 100;
const MAX_NAME = 120;
const MAX_STORED_SUBJECT = 200;

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

type TriageOutcome =
  "skipped" | "gone" | "unparseable" | "applied" | "lost" | "mailbox_lost" | "held";

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

function storedHeader(header: MailHeader): {
  sender: MailSender;
  subject: string;
  receivedAt: number;
} {
  const { sender } = header;
  return {
    sender: {
      ...sender,
      name: sender.name.slice(0, MAX_NAME),
    },
    subject: header.subject.slice(0, MAX_STORED_SUBJECT),
    receivedAt: header.receivedAt,
  };
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
    if (item.attempt - (item.heldClaims ?? 0) >= MAX_TRIAGE_ATTEMPTS) {
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
      grant: storedGrant(mailbox),
    };
  },
});

export const releaseClaim = internalMutation({
  args: { itemId: v.id("mailItems"), attempt: v.number(), held: v.boolean() },
  handler: async (ctx, { itemId, attempt, held }): Promise<null> => {
    const item = await ctx.db.get(itemId);
    if (holdsClaim(item, attempt)) {
      await ctx.db.patch(itemId, {
        state: "queued",
        leaseUntil: Date.now() + TRIAGE_PICKUP_MS,
        ...(held ? { heldClaims: (item.heldClaims ?? 0) + 1 } : {}),
      });
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
  ): Promise<{ known: KnownInvite | null } | null> => {
    const item = await ctx.db.get(itemId);
    if (!holdsClaim(item, attempt)) return null;
    const stored = storedHeader(header);
    await ctx.db.patch(itemId, stored);
    const link =
      icsKey === null ? null : await senderLink(ctx, item.householdId, stored.sender, icsKey);
    return { known: link === null ? null : { sequence: link.sequence ?? 0 } };
  },
});

function eventFact(event: Doc<"events">, date: string): CalendarEventFact {
  return {
    eventId: event._id,
    title: event.title,
    date,
    time: event.startTime,
    durationMinutes: event.durationMinutes ?? null,
    repeating: event.repeatDays !== undefined,
  };
}

function datesNamed(verdict: MailVerdict): string[] {
  if (verdict.kind !== "appointment") return [];
  if (verdict.change === "cancel") return [verdict.previous.date];
  const { date } = verdict.appointment;
  const dates = [addDays(date, -1), date];
  return verdict.change === "reschedule" && verdict.previous !== null
    ? [...dates, verdict.previous.date]
    : dates;
}

async function calendarFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
  verdict: MailVerdict,
): Promise<{ events: Doc<"events">[]; facts: CalendarEventFact[] }> {
  const inHorizon = (date: string) => factsCover(date, { now, timezone: household.timezone });
  const live = await liveEvents(ctx, household._id);
  const singles = live.filter((e) => e.repeatDays === undefined && inHorizon(e.startsOn));
  const series = live.filter((e) => e.repeatDays !== undefined);
  const occurrences = [...new Set(datesNamed(verdict).filter(inHorizon))].flatMap((date) =>
    expandOccurrences(series, household.timezone, date, date),
  );
  const facts = [
    ...singles.map((e) => eventFact(e, e.startsOn)),
    ...occurrences.map((o) => eventFact(o.event, o.localDate)),
  ];
  return { events: [...singles, ...series], facts };
}

async function linkedEvent(
  ctx: QueryCtx,
  link: Doc<"mailEventLinks">,
  event: Doc<"events">,
  sender: MailSender,
  today: string,
): Promise<LinkedEvent> {
  if (canStillOccur(event, today)) return { eventId: event._id, occurs: true };
  const maker = await ctx.db.get(link.mailItemId);
  return {
    eventId: event._id,
    occurs: false,
    date: event.startsOn,
    time: event.startTime,
    madeBy: maker?.sender?.address === sender.address ? "this_address" : "another_address",
  };
}

const triageInput = {
  itemId: v.id("mailItems"),
  attempt: v.number(),
  email: v.object({ ...mailHeader.fields, ics: v.union(v.null(), icsEvent) }),
  triaged: triagedValidator,
};

const triageInputObject = v.object(triageInput);

type TriageInput = Infer<typeof triageInputObject>;

interface Planned {
  item: Doc<"mailItems">;
  household: Doc<"households">;
  facts: PolicyFacts;
  events: Map<string, Doc<"events">>;
}

async function calendarChangesToday(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<number> {
  const startOfToday = localMidnight(now, household.timezone);
  const changed = await ctx.db
    .query("mailItems")
    .withIndex("by_household_calendar_changed", (q) =>
      q.eq("householdId", household._id).gte("calendarChangedAt", startOfToday),
    )
    .take(MAX_CALENDAR_CHANGES_PER_DAY);
  return changed.length;
}

async function planned(
  ctx: QueryCtx,
  { itemId, attempt, email, triaged }: TriageInput,
  now: number,
): Promise<Planned | "lost" | "mailbox_gone"> {
  const item = await ctx.db.get(itemId);
  if (!holdsClaim(item, attempt)) return "lost";
  const household = await ctx.db.get(item.householdId);
  if (!household || !(await mailboxOf(ctx, item))) return "mailbox_gone";
  const calendar = await calendarFacts(ctx, household, now, triaged.verdict);
  const events = new Map<string, Doc<"events">>(calendar.events.map((e) => [e._id, e]));
  const key = linkKey(triaged.verdict, email.ics);
  const header = storedHeader(email);
  const link = key === null ? null : await senderLink(ctx, household._id, header.sender, key);
  const linked = link === null ? null : await ctx.db.get(link.eventId);
  if (linked !== null) events.set(linked._id, linked);
  const today = localDate(now, household.timezone);
  const facts: PolicyFacts = {
    now,
    timezone: household.timezone,
    sender: header.sender,
    subject: header.subject,
    receivedAt: header.receivedAt,
    gmailId: item.gmailId,
    ics: email.ics,
    events: calendar.facts,
    linked:
      link === null || linked === null
        ? null
        : await linkedEvent(ctx, link, linked, header.sender, today),
    calendarChangesToday: await calendarChangesToday(ctx, household, now),
  };
  return { item, household, facts, events };
}

export const postsToCaregivers = internalQuery({
  args: triageInput,
  handler: async (ctx, input): Promise<boolean> => {
    const ready = await planned(ctx, input, Date.now());
    if (typeof ready === "string") return false;
    return planWithRule(input.triaged, ready.facts).effects.some(
      (e) => e.kind === "tell_caregivers" || e.kind === "escalate",
    );
  },
});

export const applyTriage = internalMutation({
  args: { ...triageInput, caregiverSummary: v.union(v.null(), v.string()) },
  handler: async (ctx, { caregiverSummary, ...input }): Promise<boolean> => {
    const now = Date.now();
    const ready = await planned(ctx, input, now);
    if (ready === "lost") return false;
    if (ready === "mailbox_gone") {
      await ctx.db.patch(input.itemId, { state: "failed", leaseUntil: undefined });
      return false;
    }
    const { item, household, facts, events } = ready;
    const { triaged } = input;
    const summary = caregiverSummary ?? triaged.summary;
    const plan = planWithRule({ verdict: triaged.verdict, summary }, facts);
    const effects = await carryOut({ ctx, household, item, facts, events, summary }, plan.effects);
    await ctx.db.patch(item._id, {
      ...storedHeader(input.email),
      state: "done",
      leaseUntil: undefined,
      verdict: triaged.verdict.kind,
      rule: plan.rule,
      judgeRule: triaged.rule,
      judgeAnswers: triaged.answers ?? undefined,
      effects,
      escalatedAt: effects.some((e) => e.kind === "escalated") ? now : undefined,
      calendarChangedAt: effects.some(
        (e) => e.kind === "event_added" || e.kind === "event_rescheduled",
      )
        ? now
        : undefined,
      classifier: triaged.classifier,
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
  const failure = await mailFailure(ctx, claim.mailboxId, claim.grant.refreshToken, e);
  const release = (held: boolean) =>
    ctx.runMutation(internal.mailTriage.releaseClaim, { itemId, attempt: claim.attempt, held });
  switch (failure.kind) {
    case "permanent":
      throw new NonRetryableError(errorText(e), { cause: e });
    case "grant":
      await release(false);
      return "mailbox_lost";
    case "setup":
      console.error(`Mail triage held until the deployment is fixed: ${errorText(e)}`);
      await release(true);
      return "held";
    case "retry":
      await release(false);
      throw e;
  }
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
  const header = {
    sender: email.sender,
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
  const triaged = await triageEmail(email, { now: claim.now, timezone }, parsed.known, askJev);
  const input = { itemId, attempt, email: { ...header, ics: email.ics }, triaged };
  const caregiverSummary = (await ctx.runQuery(internal.mailTriage.postsToCaregivers, input))
    ? await summarizeForCaregivers(email)
    : null;
  const applied = await ctx.runMutation(internal.mailTriage.applyTriage, {
    ...input,
    caregiverSummary,
  });
  return applied ? "applied" : "lost";
}

export const triage = internalAction({
  args: { itemId: v.id("mailItems") },
  handler: async (ctx, { itemId }): Promise<TriageOutcome> => {
    const claim: Claim = await ctx.runMutation(internal.mailTriage.claimItem, { itemId });
    if (claim.kind === "skip") return "skipped";
    const tokens = await tokensFor(ctx, { table: "mailboxes", id: claim.mailboxId }, claim.grant);
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
    await postMail(ctx, household, item._id, unreadPost(item, household), now);
  }
}

function unreadPost(item: Doc<"mailItems">, household: Doc<"households">): string {
  const { sender, subject, receivedAt } = item;
  if (sender === undefined || subject === undefined || receivedAt === undefined) {
    return "Sunny could not read an email. Please look at the inbox in Gmail.";
  }
  return caregiverText({ timezone: household.timezone, sender, subject, receivedAt }, [
    "Sunny could not read an email. Please look at it in Gmail.",
  ]);
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
