import { NO_USAGE } from "./mailTypes";
import type { KnownInvite, MailVerdict, ParsedEmail, Triaged } from "./mailTypes";

const IGNORED_LABELS = [
  "SPAM",
  "TRASH",
  "SENT",
  "DRAFT",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
];

function settled(verdict: MailVerdict, summary: string, rule: string): Triaged {
  return {
    verdict,
    summary,
    rule: `gate:${rule}`,
    classifier: { name: "gate", usage: NO_USAGE },
    answers: null,
  };
}

export function gate(email: ParsedEmail, known: KnownInvite | null): Triaged | null {
  const label = IGNORED_LABELS.find((l) => email.labels.includes(l));
  if (label !== undefined) {
    return settled({ kind: "ignore" }, `Filed by Gmail as ${label}.`, `label:${label}`);
  }
  const ics = email.ics;
  if (ics === null) return null;
  if (ics.method === "REPLY") {
    return settled({ kind: "ignore" }, "A reply to a calendar invitation.", "ics:reply");
  }
  if (ics.recurring) {
    return settled(
      { kind: "needs_decision", reason: "other" },
      "A calendar invitation for a repeating appointment, or for one date of one.",
      "ics:recurring",
    );
  }
  if (known !== null && ics.sequence < known.sequence) {
    return settled(
      { kind: "ignore" },
      "An older version of a calendar invitation Sunny already has.",
      "ics:older_sequence",
    );
  }
  return null;
}
