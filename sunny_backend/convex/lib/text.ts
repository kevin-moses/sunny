import { appError } from "./errors";

export function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const LINE_BREAKS = /\s*[\r\n\v\f\u0085\u2028\u2029]+\s*/g;

export function joinLines(value: string): string {
  return value.trim().replace(LINE_BREAKS, " / ");
}

export function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

export function textKey(value: string): string {
  return oneLine(value).toLowerCase();
}

export function searchWords(words: string | null | undefined): string {
  return (words ?? "").trim().toLowerCase();
}

export function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw appError("invalid", `${label} cannot be blank`);
  return trimmed;
}

export function requireMaxLength(value: string, max: number, label: string): string {
  if (value.length > max) throw appError("invalid", `${label} is too long (${max} at most)`);
  return value;
}

export function cleanOptional(
  value: string | undefined,
  max: number,
  label: string,
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return requireMaxLength(trimmed, max, label);
}

export function normalizeWeekdays(days: number[], message: string): number[] {
  if (!days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    throw appError("invalid", message);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}
