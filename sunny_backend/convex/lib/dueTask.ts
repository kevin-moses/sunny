import { isAnytimeInstance } from "./anytime";
import { searchWords } from "./text";
import type { TodayEntry } from "./today";

export type DuePickStatus = Partial<TodayEntry> & {
  status: "nothing_due" | "not_found" | "ambiguous" | "already_done";
  options?: TodayEntry[];
};

export function isDueEntry(e: Pick<TodayEntry, "state">): boolean {
  return e.state === "due" || e.state === "escalated";
}

export function pickDueEntry(
  today: TodayEntry[],
  said: string | null | undefined,
): DuePickStatus | { entry: TodayEntry } {
  const label = searchWords(said);
  if (label === "") {
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
