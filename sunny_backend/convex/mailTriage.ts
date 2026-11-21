import { NonRetryableError, vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { tokensFor } from "./googleGrant";
import type { GrantJob } from "./googleGrant";
import { closeHolds } from "./serviceHolds";
import { postMail } from "./lib/chatPosts";
import { errorText } from "./lib/errors";
import { getMessage } from "./lib/gmailApi";
import { storedGrant } from "./lib/googleTokens";
import type { StoredGrant } from "./lib/googleTokens";
import { carryOut } from "./lib/mailEffects";
import { knownInvite, loadFacts, recordedHeader, senderLink } from "./lib/mailFacts";
import type { LoadedFacts } from "./lib/mailFacts";
import { askJev } from "./lib/jevClient";
import { triageEmail } from "./lib/mailJudge";
import { parseGmailMessage } from "./lib/mailParse";
import { icsKey } from "./lib/mailLinks";
import { planWithRule } from "./lib/mailPolicy";
import { caregiverMessage } from "./lib/mailProse";
import type { KnownInvite, MailHeader, ParsedEmail } from "./lib/mailTypes";
import { TRIAGE_PICKUP_MS, enqueueTriage, jobInPool } from "./lib/mailPool";
import { summarizeForCaregivers } from "./lib/mailSummary";
import { MAIL_SERVICES, enterGate, holdGate, holdService, rearmProbes } from "./lib/serviceHolds";
import type { HoldGate, HoldService } from "./lib/serviceHolds";
import { MINUTE_MS } from "./lib/time";
import { icsEvent, mailHeader, triaged as triagedValidator } from "./lib/validators";

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
      probe: boolean;
    };

type Claimed = Extract<Claim, { kind: "claimed" }>;

type TriageOutcome =
  "skipped" | "gone" | "unparseable" | "applied" | "lost" | "mailbox_lost" | "held";

type Applied = "lost" | "applied" | "posted";

interface Finished {
  outcome: TriageOutcome;
  used: HoldService[];
}

type Readiness =
  | { kind: "waits"; reason: string }
  | { kind: "orphan" }
  | { kind: "ready"; household: Doc<"households">; mailbox: Doc<"mailboxes"> };

const SWEEP_ENQUEUES: Record<HoldGate, number> = { free: Infinity, probe: 1, held: 0 };

const unreadRule = v.union(v.literal("gone"), v.literal("unparseable"));

function holdsClaim(item: Doc<"mailItems"> | null, attempt: number): item is Doc<"mailItems"> {
  return item !== null && item.state === "triaging" && item.attempt === attempt;
}

function storedHeader(header: MailHeader): MailHeader {
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

async function readiness(ctx: QueryCtx, item: Doc<"mailItems">): Promise<Readiness> {
  const household = await ctx.db.get(item.householdId);
  if (household?.backgroundPaused) return { kind: "waits", reason: "household paused" };
  const mailbox = await mailboxOf(ctx, item);
  if (!household || !mailbox) return { kind: "orphan" };
  if (mailbox.status !== "active") return { kind: "waits", reason: "mailbox not active" };
  return { kind: "ready", household, mailbox };
}

async function failOrphan(ctx: MutationCtx, itemId: Id<"mailItems">): Promise<void> {
  await ctx.db.patch(itemId, { state: "failed", leaseUntil: undefined });
}

export const claimItem = internalMutation({
  args: { itemId: v.id("mailItems") },
  handler: async (ctx, { itemId }): Promise<Claim> => {
    const item = await ctx.db.get(itemId);
    if (!item || item.state !== "queued") return { kind: "skip", reason: "not queued" };
    const ready = await readiness(ctx, item);
    if (ready.kind === "orphan") {
      await failOrphan(ctx, itemId);
      return { kind: "skip", reason: "mailbox gone" };
    }
    if (ready.kind === "waits") return { kind: "skip", reason: ready.reason };
    const { household, mailbox } = ready;
    if (item.attempt - (item.heldClaims ?? 0) >= MAX_TRIAGE_ATTEMPTS) {
      await failUnread(ctx, item);
      return { kind: "skip", reason: "attempts used up" };
    }
    const now = Date.now();
    const gate = await enterGate(ctx, MAIL_SERVICES, now);
    if (gate === "held") return { kind: "skip", reason: "mail held" };
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
      probe: gate === "probe",
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
    { itemId, attempt, icsKey: inviteKey, ...header },
  ): Promise<{ known: KnownInvite | null } | null> => {
    const item = await ctx.db.get(itemId);
    if (!holdsClaim(item, attempt)) return null;
    const stored = storedHeader(header);
    await ctx.db.patch(itemId, stored);
    const link =
      inviteKey === null ? null : await senderLink(ctx, item.householdId, stored.sender, inviteKey);
    return { known: knownInvite(link) };
  },
});

const triageInput = v.object({
  itemId: v.id("mailItems"),
  attempt: v.number(),
  ics: v.union(v.null(), icsEvent),
  triaged: triagedValidator,
});

type TriageInput = Infer<typeof triageInput>;

interface Planned extends LoadedFacts {
  item: Doc<"mailItems">;
  household: Doc<"households">;
}

async function planned(
  ctx: QueryCtx,
  { itemId, attempt, ics, triaged }: TriageInput,
  now: number,
): Promise<Planned | "lost" | "mailbox_gone"> {
  const item = await ctx.db.get(itemId);
  if (!holdsClaim(item, attempt)) return "lost";
  const header = recordedHeader(item);
  if (header === null) {
    throw new Error("Mail triage was applied before recordParsed stored the email's header");
  }
  const household = await ctx.db.get(item.householdId);
  if (!household || !(await mailboxOf(ctx, item))) return "mailbox_gone";
  const loaded = await loadFacts(ctx, { household, header, now, verdict: triaged.verdict, ics });
  return { item, household, ...loaded };
}

export const applyTriage = internalMutation({
  args: triageInput.fields,
  handler: async (ctx, input): Promise<Applied> => {
    const now = Date.now();
    const ready = await planned(ctx, input, now);
    if (ready === "lost") return "lost";
    if (ready === "mailbox_gone") {
      await failOrphan(ctx, input.itemId);
      return "lost";
    }
    const { item, household, facts, events } = ready;
    const { triaged } = input;
    const plan = planWithRule(triaged, facts);
    const effects = await carryOut({ ctx, household, item, facts, events }, plan.effects);
    await ctx.db.patch(item._id, {
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
    return effects.some((e) => e.kind === "told_caregivers" || e.kind === "escalated")
      ? "posted"
      : "applied";
  },
});

export const replaceSummary = internalMutation({
  args: {
    itemId: v.id("mailItems"),
    attempt: v.number(),
    ics: v.union(v.null(), icsEvent),
    summary: v.string(),
  },
  handler: async (ctx, { itemId, attempt, ics, summary }): Promise<boolean> => {
    const item = await ctx.db.get(itemId);
    if (item === null || item.state !== "done" || item.attempt !== attempt) return false;
    const { caregiverPost } = item;
    if (caregiverPost === undefined) return false;
    const post = await ctx.db.get(caregiverPost.postId);
    if (post?.kind !== "mail" || post.mailItemId !== itemId) return false;
    await ctx.db.patch(post._id, {
      body: caregiverMessage(ics, caregiverPost.line, summary).body,
    });
    return true;
  },
});

async function summarizePost(
  ctx: ActionCtx,
  itemId: Id<"mailItems">,
  attempt: number,
  email: ParsedEmail,
): Promise<void> {
  const summary = await summarizeForCaregivers(email);
  if (summary === null) return;
  await ctx.runMutation(internal.mailTriage.replaceSummary, {
    itemId,
    attempt,
    ics: email.ics,
    summary,
  });
}

async function settleTriageError(
  ctx: ActionCtx,
  itemId: Id<"mailItems">,
  claim: Claimed,
  job: GrantJob,
  e: unknown,
): Promise<TriageOutcome> {
  const cause = await job.settle(e);
  const release = (held: boolean) =>
    ctx.runMutation(internal.mailTriage.releaseClaim, { itemId, attempt: claim.attempt, held });
  switch (cause) {
    case "permanent":
      throw new NonRetryableError(errorText(e), { cause: e });
    case "revoked":
    case "unreadable":
    case "forbidden":
      await release(false);
      return "mailbox_lost";
    case "hold":
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
  claim: Claimed,
  job: GrantJob,
): Promise<Finished> {
  const { attempt, timezone } = claim;
  const raw = await job.tokens.withToken((token) => getMessage(token, claim.gmailId));
  const email = raw === null ? null : parseGmailMessage(raw, timezone);
  if (email === null) {
    const rule = raw === null ? "gone" : "unparseable";
    await ctx.runMutation(internal.mailTriage.closeUnread, { itemId, attempt, rule });
    return { outcome: rule, used: ["gmail"] };
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
    icsKey: email.ics === null ? null : icsKey(email.ics),
  });
  if (parsed === null) return { outcome: "lost", used: ["gmail"] };
  const triaged = await triageEmail(email, { now: claim.now, timezone }, parsed.known, askJev);
  const used: HoldService[] = triaged.answers === null ? ["gmail"] : ["gmail", "jev"];
  const applied: Applied = await ctx.runMutation(internal.mailTriage.applyTriage, {
    itemId,
    attempt,
    ics: email.ics,
    triaged,
  });
  if (applied === "lost") return { outcome: "lost", used };
  if (applied === "posted") await summarizePost(ctx, itemId, attempt, email);
  return { outcome: "applied", used };
}

export const triage = internalAction({
  args: { itemId: v.id("mailItems") },
  handler: async (ctx, { itemId }): Promise<TriageOutcome> => {
    const claim: Claim = await ctx.runMutation(internal.mailTriage.claimItem, { itemId });
    if (claim.kind === "skip") {
      console.log(`Mail triage skipped: ${claim.reason}`);
      return "skipped";
    }
    const job = await tokensFor(
      ctx,
      { table: "mailboxes", id: claim.mailboxId },
      claim.grant,
      claim.now,
    );
    let finished: Finished;
    try {
      finished = await triageClaimed(ctx, itemId, claim, job);
    } catch (e) {
      return await settleTriageError(ctx, itemId, claim, job, e);
    }
    if (claim.probe) await settleProbe(ctx, finished.used, claim.now);
    return finished.outcome;
  },
});

async function settleProbe(ctx: ActionCtx, used: HoldService[], since: number): Promise<void> {
  await closeHolds(ctx, used, since);
  const untested = MAIL_SERVICES.filter((service) => !used.includes(service));
  if (untested.length > 0) {
    await ctx.runMutation(internal.mailTriage.probeAgain, { services: untested, since });
  }
}

async function enqueueNextClaim(ctx: MutationCtx): Promise<void> {
  const rows = await ctx.db
    .query("mailItems")
    .withIndex("by_state_lease", (q) => q.eq("state", "queued"))
    .take(SWEEP_BATCH);
  for (const row of rows) {
    const ready = await readiness(ctx, row);
    if (ready.kind === "orphan") await failOrphan(ctx, row._id);
    if (ready.kind !== "ready") continue;
    if (!(await jobInPool(ctx, row.jobId))) await enqueueTriage(ctx, row._id);
    return;
  }
}

export const probeAgain = internalMutation({
  args: { services: v.array(holdService), since: v.number() },
  handler: async (ctx, { services, since }): Promise<HoldService[]> => {
    const rearmed = await rearmProbes(ctx, services, since, Date.now());
    if (rearmed.length > 0) await enqueueNextClaim(ctx);
    return rearmed;
  },
});

async function failUnread(ctx: MutationCtx, item: Doc<"mailItems">): Promise<void> {
  await ctx.db.patch(item._id, { state: "failed", leaseUntil: undefined });
  const household = await ctx.db.get(item.householdId);
  if (household) {
    const now = Date.now();
    await postMail(ctx, household, item, unreadPost(item), now);
  }
}

function unreadPost(item: Doc<"mailItems">): string {
  return recordedHeader(item) === null
    ? "Sunny could not read an email. Please look at the inbox in Gmail."
    : "Sunny could not read an email. Please look at it in Gmail.";
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
  enqueues: number,
): Promise<number> {
  const rows = await ctx.db
    .query("mailItems")
    .withIndex("by_state_lease", (q) => q.eq("state", state).lt("leaseUntil", now))
    .take(SWEEP_BATCH);
  let queued = 0;
  for (const row of rows) {
    if (state === "queued" && (await jobInPool(ctx, row.jobId))) {
      await ctx.db.patch(row._id, { leaseUntil: now + TRIAGE_PICKUP_MS });
      continue;
    }
    const ready = await readiness(ctx, row);
    if (ready.kind === "orphan") {
      await failOrphan(ctx, row._id);
      continue;
    }
    await ctx.db.patch(row._id, { state: "queued", leaseUntil: now + TRIAGE_PICKUP_MS });
    if (queued >= enqueues || ready.kind === "waits") continue;
    await enqueueTriage(ctx, row._id);
    queued += 1;
  }
  return queued;
}

export const sweepStuck = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    const enqueues = SWEEP_ENQUEUES[await holdGate(ctx, MAIL_SERVICES, now)];
    const lapsed = await requeueOverdue(ctx, "triaging", now, enqueues);
    return lapsed + (await requeueOverdue(ctx, "queued", now, enqueues - lapsed));
  },
});
