import { DECISION_REASONS, INFO_TOPICS, SUSPICIONS } from "./mailTypes";
import type { DecisionReason, InfoTopic, MailVerdict, Suspicion } from "./mailTypes";
import { isRecord } from "./http";
import { isLocalDate, isLocalTime } from "./time";

type VerdictKind = MailVerdict["kind"];
type Change = Extract<MailVerdict, { kind: "appointment" }>["change"];
type ShapeOf<V> = V extends { kind: "appointment"; change: infer C extends string }
  ? `appointment:${C}`
  : V extends { kind: infer K extends string }
    ? K
    : never;
type ShapeKey = ShapeOf<MailVerdict>;

function everyOf<T extends string>() {
  return <const A extends readonly T[]>(values: A & ([T] extends [A[number]] ? unknown : never)) =>
    values;
}

const VERDICT_KINDS = everyOf<VerdictKind>()([
  "ignore",
  "appointment",
  "senior_info",
  "needs_decision",
  "suspicious",
]);
const CHANGES = everyOf<Change>()(["new", "reschedule", "cancel"]);

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: "null" }] };
}

const PROPERTIES = {
  summary: { type: "string" },
  kind: { type: "string", enum: VERDICT_KINDS },
  change: nullable({ type: "string", enum: CHANGES }),
  title: nullable({ type: "string" }),
  date: nullable({ type: "string" }),
  time: nullable({ type: "string" }),
  duration_minutes: nullable({ type: "integer" }),
  place: nullable({ type: "string" }),
  previous_date: nullable({ type: "string" }),
  previous_time: nullable({ type: "string" }),
  previous_title: nullable({ type: "string" }),
  topic: nullable({ type: "string", enum: [...INFO_TOPICS] }),
  note: nullable({ type: "string" }),
  reason: nullable({ type: "string", enum: [...DECISION_REASONS] }),
  suspicion: nullable({ type: "string", enum: [...SUSPICIONS] }),
};

type Field = Exclude<keyof typeof PROPERTIES, "summary" | "kind">;

function isField(key: string): key is Field {
  return key in PROPERTIES && key !== "summary" && key !== "kind";
}

export const VERDICT_SCHEMA = {
  type: "object",
  properties: PROPERTIES,
  required: Object.keys(PROPERTIES),
  additionalProperties: false,
};

const SHAPES: Record<ShapeKey, ReadonlySet<Field>> = {
  ignore: new Set(),
  "appointment:new": new Set(["change", "title", "date", "time", "duration_minutes", "place"]),
  "appointment:reschedule": new Set([
    "change",
    "title",
    "date",
    "time",
    "duration_minutes",
    "place",
    "previous_date",
    "previous_time",
    "previous_title",
  ]),
  "appointment:cancel": new Set(["change", "previous_date", "previous_time", "previous_title"]),
  senior_info: new Set(["topic", "note"]),
  needs_decision: new Set(["reason"]),
  suspicious: new Set(["suspicion"]),
};

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return values.find((v) => v === value) ?? null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function date(value: unknown): string | null {
  return typeof value === "string" && isLocalDate(value) ? value : null;
}

function time(value: unknown): string | null {
  return typeof value === "string" && isLocalTime(value) ? value : null;
}

function orNull<T>(value: unknown, read: (v: unknown) => T | null): T | null | undefined {
  if (value === null || value === undefined) return null;
  return read(value) ?? undefined;
}

function place(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value.trim() || null : undefined;
}

function minutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function shapeOf(kind: VerdictKind, change: unknown): ShapeKey | null {
  if (kind !== "appointment") return kind;
  const known = oneOf(CHANGES, change);
  return known === null ? null : `appointment:${known}`;
}

export function parseVerdict(input: unknown): MailVerdict | null {
  if (!isRecord(input)) return null;
  const summary = text(input.summary);
  const kind = oneOf(VERDICT_KINDS, input.kind);
  if (summary === null || kind === null) return null;
  const shapeKey = shapeOf(kind, input.change);
  if (shapeKey === null) return null;
  const allowed = SHAPES[shapeKey];
  for (const key of Object.keys(input)) {
    if (key === "summary" || key === "kind") continue;
    if (!isField(key)) return null;
    if (!allowed.has(key) && input[key] !== null && input[key] !== undefined) return null;
  }
  switch (shapeKey) {
    case "ignore":
      return { kind: "ignore", summary };
    case "senior_info": {
      const topic: InfoTopic | null = oneOf(INFO_TOPICS, input.topic);
      const note = text(input.note);
      return topic === null || note === null ? null : { kind: "senior_info", topic, note, summary };
    }
    case "needs_decision": {
      const reason: DecisionReason | null = oneOf(DECISION_REASONS, input.reason);
      return reason === null ? null : { kind: "needs_decision", reason, summary };
    }
    case "suspicious": {
      const suspicion: Suspicion | null = oneOf(SUSPICIONS, input.suspicion);
      return suspicion === null ? null : { kind: "suspicious", suspicion, summary };
    }
  }
  const previousDate = date(input.previous_date);
  const previousTime = orNull(input.previous_time, time);
  const previousTitle =
    typeof input.previous_title === "string" ? input.previous_title.trim() : null;
  const previous =
    previousDate === null || previousTime === undefined || previousTitle === null
      ? null
      : { date: previousDate, time: previousTime, title: previousTitle };
  if (shapeKey === "appointment:cancel") {
    return previous === null ? null : { kind: "appointment", change: "cancel", previous, summary };
  }
  const title = text(input.title);
  const day = date(input.date);
  const start = time(input.time);
  const durationMinutes = orNull(input.duration_minutes, minutes);
  const where = place(input.place);
  if (title === null || day === null || start === null) return null;
  if (durationMinutes === undefined || where === undefined) return null;
  const appointment = { title, date: day, time: start, durationMinutes, place: where };
  if (shapeKey === "appointment:new") {
    return { kind: "appointment", change: "new", appointment, summary };
  }
  return previous === null
    ? null
    : { kind: "appointment", change: "reschedule", previous, appointment, summary };
}
