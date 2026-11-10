// lib/text.ts
// Purpose: Small input-normalization helpers shared by the Convex functions: blank-string
// and length checks and ISO weekday lists. Each throws the "invalid" application error with a
// caller-supplied message so every function keeps its own wording. Also the one way text is
// flattened to a single line (oneLine) and the one comparison key for duplicates (textKey:
// one line, lower case), used by the life profile, agent memory and the household list;
// searchWords is the one normalization of words that name a task or medication.
//
// Last modified: 2026-11-09

import { appError } from "./errors";

/**
 * purpose: Text as one trimmed line: every run of whitespace, line breaks included, becomes
 *          a single space.
 * @param value: (string) Raw text.
 * @return: (string) The single-line text ("" for blank text).
 */
export function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * purpose: The key two texts are compared by for duplicates: one line, lower case.
 * @param value: (string) Text.
 * @return: (string) The key.
 */
export function textKey(value: string): string {
  return oneLine(value).toLowerCase();
}

/**
 * purpose: Words that name a task or medication, normalized for a contains-match against a
 *          label: trimmed and lower case (inner spacing kept as said).
 * @param words: (string | null | undefined) The words, if any.
 * @return: (string) The normalized words; "" for none.
 */
export function searchWords(words: string | null | undefined): string {
  return (words ?? "").trim().toLowerCase();
}

/**
 * purpose: Reject a blank string.
 * @param value: (string) Candidate.
 * @param label: (string) Field name for the error message.
 * @return: (string) The trimmed value.
 * @raises invalid when blank.
 */
export function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw appError("invalid", `${label} cannot be blank`);
  return trimmed;
}

/**
 * purpose: Reject text longer than a limit.
 * @param value: (string) Candidate (already trimmed by the caller where that matters).
 * @param max: (number) Maximum length.
 * @param label: (string) Field name for the error message.
 * @return: (string) The value unchanged.
 * @raises invalid when longer than max.
 */
export function requireMaxLength(value: string, max: number, label: string): string {
  if (value.length > max) throw appError("invalid", `${label} is too long (${max} at most)`);
  return value;
}

/**
 * purpose: Trim an optional text field; blank becomes absent.
 * @param value: (string | undefined) Raw text.
 * @param max: (number) Maximum length after trimming.
 * @param label: (string) Field name for the error message.
 * @return: (string | undefined) The trimmed text, or undefined when blank or absent.
 * @raises invalid when longer than max.
 */
export function cleanOptional(
  value: string | undefined,
  max: number,
  label: string,
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return requireMaxLength(trimmed, max, label);
}

/**
 * purpose: Validate ISO weekdays (1 Monday to 7 Sunday) and return them de-duplicated and
 *          sorted.
 * @param days: (number[]) Raw weekdays.
 * @param message: (string) Error message when any is not a whole number from 1 to 7.
 * @return: (number[]) Distinct weekdays in ascending order.
 * @raises invalid when any weekday is out of range.
 */
export function normalizeWeekdays(days: number[], message: string): number[] {
  if (!days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    throw appError("invalid", message);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}
