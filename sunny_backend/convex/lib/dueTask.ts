// lib/dueTask.ts
// Purpose: Which of today's entries "the task" means, the one rule shared by "Done"
// (instances.confirmDueTaskCore: the button, the widget and voice confirm) and "not yet" (the
// voice agent's agent.snoozeDueTask). Moved out of instances.ts so both use it. The label is
// normalized here (text.searchWords), so callers pass what was said or typed.
//
// Last modified: 2026-11-09

import { isAnytimeInstance } from "./anytime";
import { searchWords } from "./text";
import type { TodayEntry } from "./today";

/** A final answer (no entry to act on), shaped like instances.ConfirmDueResult. */
export type DuePickStatus = Partial<TodayEntry> & {
  status: "nothing_due" | "not_found" | "ambiguous" | "already_done";
  options?: TodayEntry[];
};

/**
 * purpose: Whether an entry is open for confirmation right now.
 * @param e: (TodayEntry) The entry.
 * @return: (boolean) True when due or escalated.
 */
export function isDueEntry(e: Pick<TodayEntry, "state">): boolean {
  return e.state === "due" || e.state === "escalated";
}

/**
 * purpose: Pick the entry "Done" (or "not yet") means. No label: the earliest due or escalated
 *          timed entry (anytime entries are only matched by label). With a label: entries whose
 *          display label contains it (case-insensitive), preferring those due now, then any
 *          still open, else already done.
 * @param today: (TodayEntry[]) Today's entries in schedule order.
 * @param said: (string | null | undefined) The label as said or typed; blank or absent for
 *        none.
 * @return: (DuePickStatus | {entry: TodayEntry}) A final result, or the entry to act on.
 */
export function pickDueEntry(
  today: TodayEntry[],
  said: string | null | undefined,
): DuePickStatus | { entry: TodayEntry } {
  const label = searchWords(said);
  if (label === "") {
    // An anytime entry is open all day, so a bare "Done" never means it; it needs its label.
    const entry = today.find((e) => isDueEntry(e) && !isAnytimeInstance(e));
    return entry ? { entry } : { status: "nothing_due" };
  }
  const matches = today.filter((e) => e.displayLabel.toLowerCase().includes(label));
  if (matches.length === 0) return { status: "not_found" };
  let open = matches.filter(isDueEntry);
  if (open.length === 0) {
    open = matches.filter((e) => e.state !== "confirmed" && e.state !== "resolved");
  }
  if (open.length === 0) {
    const latest = matches.reduce((a, b) => ((b.confirmedAt ?? 0) > (a.confirmedAt ?? 0) ? b : a));
    return { ...latest, status: "already_done" };
  }
  if (open.length > 1) return { status: "ambiguous", options: open };
  return { entry: open[0]! };
}
