import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isAsNeededTask } from "../tasks";
import { memberNames } from "./access";
import { isAnytimeInstance } from "./anytime";
import { caregiverAlerted } from "./escalation";
import { dayRange, formatTime12, localTime } from "./time";
import { receivedDaysLater } from "./today";
import type { ConfirmVia } from "./validators";

const DAY_READ_CAP = 200;

export type TaskOutcome = "confirmed" | "resolved" | "missed" | "escalated" | "open";

export interface TaskFact {
  label: string;
  scheduledAt: string;
  outcome: TaskOutcome;
  doneAt?: string;
  via?: ConfirmVia;
  sentAt?: string;
  sentDaysLater?: number;
  resolvedBy?: string;
  claimedBy?: string;
  alerted: boolean;
}

export interface DoseFact {
  label: string;
  times: string[];
}

export interface RepeatFact {
  topic: string;
  count: number;
}

export interface DigestFacts {
  seniorName: string;
  localDate: string;
  tasks: TaskFact[];
  doses: DoseFact[];
  questionCount: number;
  unanswered: string[];
  routed: string[];
  repeats: RepeatFact[];
  listAdded: string[];
}

function nameOf(names: Map<string, string>, userId: string | undefined): string | undefined {
  return userId === undefined ? undefined : (names.get(userId) ?? "a caregiver");
}

async function taskFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  localDate: string,
  names: Map<string, string>,
): Promise<TaskFact[]> {
  const instances = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_date", (q) =>
      q.eq("householdId", household._id).eq("localDate", localDate),
    )
    .take(DAY_READ_CAP);
  const logged = instances
    .filter((i) => !isAnytimeInstance(i))
    .sort((a, b) => a.windowStart - b.windowStart);
  const taskIds = [...new Set(logged.map((i) => i.taskId))];
  const labels = new Map<Id<"tasks">, string | undefined>(
    await Promise.all(
      taskIds.map(
        async (id) =>
          [id, (await ctx.db.get(id))?.displayLabel] as [Id<"tasks">, string | undefined],
      ),
    ),
  );
  const facts: TaskFact[] = [];
  for (const instance of logged) {
    const label = labels.get(instance.taskId);
    if (label === undefined) continue;
    const state: TaskOutcome =
      instance.state === "upcoming" || instance.state === "due" ? "open" : instance.state;
    const fact: TaskFact = {
      label,
      scheduledAt: formatTime12(instance.scheduledTime),
      outcome: state,
      alerted: caregiverAlerted(instance.firedSteps),
    };
    if (instance.confirmedAt !== undefined) {
      fact.doneAt = formatTime12(localTime(instance.confirmedAt, household.timezone));
    }
    if (instance.confirmedVia !== undefined) fact.via = instance.confirmedVia;
    if (instance.confirmReceivedAt !== undefined) {
      fact.sentAt = formatTime12(localTime(instance.confirmReceivedAt, household.timezone));
      fact.sentDaysLater = receivedDaysLater(instance, household.timezone) ?? 0;
    }
    if (state === "resolved") fact.resolvedBy = nameOf(names, instance.confirmedBy);
    const claimedBy = nameOf(names, instance.claimedBy);
    if (claimedBy !== undefined) fact.claimedBy = claimedBy;
    facts.push(fact);
  }
  return facts;
}

async function doseFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  range: { start: number; end: number },
): Promise<DoseFact[]> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household", (q) => q.eq("householdId", household._id))
    .collect();
  const perTask = await Promise.all(
    tasks
      .filter((t) => isAsNeededTask(t))
      .map(async (task) => {
        const doses = await ctx.db
          .query("doseLog")
          .withIndex("by_household_task_taken", (q) =>
            q
              .eq("householdId", household._id)
              .eq("taskId", task._id)
              .gte("takenAt", range.start)
              .lt("takenAt", range.end),
          )
          .take(DAY_READ_CAP);
        return {
          label: task.displayLabel,
          times: doses
            .filter((d) => d.undoneAt === undefined)
            .map((d) => formatTime12(localTime(d.takenAt, household.timezone))),
        };
      }),
  );
  return perTask.filter((d) => d.times.length > 0);
}

function questionFacts(
  questions: Doc<"agentQuestions">[],
  shareTranscripts: boolean,
): Pick<DigestFacts, "questionCount" | "unanswered" | "routed" | "repeats"> {
  const counts = new Map<string, number>();
  for (const q of questions) {
    const topic = q.topic.trim().toLowerCase();
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  const repeats = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  const topicsWith = (outcome: string): string[] => [
    ...new Set(
      questions
        .filter((q) => q.outcome === outcome)
        .map((q) =>
          shareTranscripts
            ? q.question.trim().replace(/[.?!\s]+$/, "")
            : q.topic.trim().toLowerCase(),
        ),
    ),
  ];
  return {
    questionCount: questions.length,
    unanswered: topicsWith("unsure"),
    routed: topicsWith("routed"),
    repeats,
  };
}

export async function gatherDigestFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  localDate: string,
): Promise<DigestFacts> {
  const range = dayRange(localDate, household.timezone);
  const names = await memberNames(ctx, household._id);
  const questions = await ctx.db
    .query("agentQuestions")
    .withIndex("by_household_asked", (q) =>
      q.eq("householdId", household._id).gte("askedAt", range.start).lt("askedAt", range.end),
    )
    .take(DAY_READ_CAP);
  const [tasks, doses] = await Promise.all([
    taskFacts(ctx, household, localDate, names),
    doseFacts(ctx, household, range),
  ]);
  const listAdded = (
    await ctx.db
      .query("listItems")
      .withIndex("by_household_added", (q) =>
        q.eq("householdId", household._id).gte("addedAt", range.start).lt("addedAt", range.end),
      )
      .take(DAY_READ_CAP)
  )
    .filter((item) => item.addedByKind === "senior")
    .map((item) => item.text);
  return {
    seniorName: household.seniorPreferredName,
    localDate,
    tasks,
    doses,
    ...questionFacts(questions, household.shareTranscripts),
    listAdded,
  };
}
