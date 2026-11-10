// sunny_app/src/caregiver/aboutFormat.ts
//
// Purpose: Pure helpers for the caregiver About tab (what Sunny knows about the senior):
// - the tab's label ("About Mom", or just "About" when the name is too long for the tab bar);
// - the life profile grouped by category, in the order the backend lists it, with section titles;
// - the inline editor's targets (one per editable text: an entry's name or details, a topic's
//   wording or guidance, a fact) with their keys, the row each belongs to, and what closing an
//   editor must save (draftToSave: nothing when the trimmed text is unchanged or a required field
//   was left blank, null to clear an optional field, else the trimmed text);
// - the status line of a memory fact (who confirmed it and when, or that the senior said it and
//   it is not confirmed yet) and the meta line of a family message (sender or "You", day, time,
//   seen);
// - what the add form does after an add (addOutcome: clear and say nothing, "Confirmed." or
//   "Already saved.", or keep the typed text and say it was not saved because the item is
//   already listed with other text);
// - short dates ("Nov 3") from the household-local "YYYY-MM-DD" dates the backend sends.
// The backend sends household-local dates and times, so nothing here converts timezones.
//
// Last modified: 2026-11-09

import type { FunctionReturnType } from 'convex/server';

import type { api, FactId, ProfileEntryId, TopicId } from '../backend/convexApi';
import { displayTime } from '../day/format';
import { dayOfMonth, monthName, parseLocalDate } from '../day/localDate';

/** One life profile entry as profile.listEntries returns it. */
export type ProfileEntry = FunctionReturnType<typeof api.profile.listEntries>[number];
/** One sensitive topic as profile.listTopics returns it. */
export type SensitiveTopic = FunctionReturnType<typeof api.profile.listTopics>[number];
/** What profile.listMemory returns: the facts and a count of older unverified ones. */
export type MemoryList = FunctionReturnType<typeof api.profile.listMemory>;
/** One memory fact as profile.listMemory returns it. */
export type MemoryFact = MemoryList['facts'][number];
/** What addOutcome reads from an add mutation's result (profile.addEntry, addTopic, addFact). */
export type AddResult = Pick<
  FunctionReturnType<typeof api.profile.addEntry>,
  'created' | 'same' | 'confirmed'
>;

/** What the add form shows after an add: whether to clear it, and an optional message. */
export interface AddOutcome {
  clear: boolean;
  message: { status: 'notice' | 'error'; text: string } | null;
}
/** One family message as profile.listMessages returns it. */
export type FamilyMessage = FunctionReturnType<typeof api.profile.listMessages>[number];
/** A life profile category. */
export type LifeCategory = ProfileEntry['category'];

/** Longest senior name shown in the tab label; longer names leave the label as "About". */
const TAB_NAME_MAX = 8;

/** profile.listMemory counts older unverified facts up to this many (OLDER_COUNT_LIMIT there). */
export const OLDER_COUNT_LIMIT = 500;

/**
 * purpose: The line under the facts when older unverified facts are not listed.
 * @param count: (number) How many, as listMemory counts them (up to OLDER_COUNT_LIMIT).
 * @param name: (string) The senior's name, or "them".
 * @return: (string) For example "12 older things Mom said are not listed."
 */
export function olderUnverifiedLine(count: number, name: string): string {
  const amount = count >= OLDER_COUNT_LIMIT ? `${count} or more` : String(count);
  return `${amount} older ${count === 1 ? 'thing' : 'things'} ${name} said ${count === 1 ? 'is' : 'are'} not listed.`;
}

/**
 * The life profile categories in the backend's category order, with their section title and
 * the short name on the add form's category chip.
 */
export const CATEGORIES: readonly { category: LifeCategory; title: string; chip: string }[] = [
  { category: 'person', title: 'People', chip: 'Person' },
  { category: 'place', title: 'Places', chip: 'Place' },
  { category: 'doctor', title: 'Doctors', chip: 'Doctor' },
  { category: 'habit', title: 'Habits', chip: 'Habit' },
  { category: 'interest', title: 'Interests', chip: 'Interest' },
  { category: 'preference', title: 'Preferences', chip: 'Preference' },
  { category: 'other', title: 'Other', chip: 'Other' },
];

/** One category's entries under its section title. */
export interface EntryGroup {
  category: LifeCategory;
  title: string;
  entries: ProfileEntry[];
}

/** One editable text on the About tab, and the text it holds now. */
export type FieldTarget =
  | { kind: 'entryName'; id: ProfileEntryId; current: string }
  | { kind: 'entryDetails'; id: ProfileEntryId; current: string | null }
  | { kind: 'topic'; id: TopicId; current: string }
  | { kind: 'guidance'; id: TopicId; current: string }
  | { kind: 'fact'; id: FactId; current: string };

/** What closing an editor must do: nothing, or save a value (null clears an optional field). */
export type DraftDecision = { save: false } | { save: true; value: string | null };

/**
 * purpose: The tab bar label of the About tab.
 * @param seniorName: (string | null) The senior's preferred name; null before it has loaded.
 * @return: (string) "About <name>" when the name is short enough for the tab, else "About".
 */
export function aboutTabLabel(seniorName: string | null): string {
  const name = seniorName?.trim() ?? '';
  return name !== '' && name.length <= TAB_NAME_MAX ? `About ${name}` : 'About';
}

/**
 * purpose: Group life profile entries by category in the backend's category order, keeping the
 *          order of the entries within a category; categories with no entries are left out.
 * @param entries: (ProfileEntry[]) Entries as profile.listEntries returns them.
 * @return: (EntryGroup[]) The non-empty groups.
 */
export function groupEntries(entries: ProfileEntry[]): EntryGroup[] {
  return CATEGORIES.map(({ category, title }) => ({
    category,
    title,
    entries: entries.filter((e) => e.category === category),
  })).filter((group) => group.entries.length > 0);
}

/**
 * purpose: The key of an editable text, unique on the screen.
 * @param target: (FieldTarget) The text.
 * @return: (string) For example "entryName:<id>".
 */
export function fieldKey(target: FieldTarget): string {
  return `${target.kind}:${target.id}`;
}

/**
 * purpose: The key of the row an editable text belongs to, which its save status is shown on.
 * @param target: (FieldTarget) The text.
 * @return: (string) "entry:<id>", "topic:<id>" or "fact:<id>".
 */
export function fieldRowKey(target: FieldTarget): string {
  return `${rowKind(target)}:${target.id}`;
}

/**
 * purpose: The kind of row an editable text belongs to.
 * @param target: (FieldTarget) The text.
 * @return: ('entry' | 'topic' | 'fact') The row kind.
 */
function rowKind(target: FieldTarget): 'entry' | 'topic' | 'fact' {
  if (target.kind === 'entryName' || target.kind === 'entryDetails') return 'entry';
  if (target.kind === 'topic' || target.kind === 'guidance') return 'topic';
  return 'fact';
}

/**
 * purpose: Decide what closing an inline editor must save. Only an entry's details are
 *          optional: leaving them blank clears them. A required text left blank is not saved
 *          (the old text stays; a blank draft holds nothing to lose).
 * @param draft: (string) The text in the editor.
 * @param target: (FieldTarget) The text being edited and its current value.
 * @return: (DraftDecision) Whether to save, and the trimmed value (null to clear).
 */
export function draftToSave(draft: string, target: FieldTarget): DraftDecision {
  const text = draft.trim();
  if (text === (target.current ?? '').trim()) return { save: false };
  if (text !== '') return { save: true, value: text };
  return target.kind === 'entryDetails' ? { save: true, value: null } : { save: false };
}

/**
 * purpose: A short label of a household-local date, for example "Nov 3".
 * @param localDate: (string) "YYYY-MM-DD".
 * @return: (string) The month's first three letters and the day, or the input when invalid.
 */
export function shortDate(localDate: string): string {
  const time = parseLocalDate(localDate);
  if (time === null) return localDate;
  return `${monthName(time).slice(0, 3)} ${dayOfMonth(time)}`;
}

/**
 * purpose: The line under a memory fact: who confirmed it and when, or where it came from.
 * @param fact: (MemoryFact) The fact.
 * @param seniorName: (string | null) The senior's preferred name, for facts they said.
 * @return: (string) For example "Confirmed by Pat, Nov 3" or "Mom said this on Nov 3. Not
 *          confirmed yet."
 */
export function factStatus(fact: MemoryFact, seniorName: string | null): string {
  if (fact.verified) {
    const by = fact.verifiedByName === null ? '' : ` by ${fact.verifiedByName}`;
    const on = fact.verifiedOn === null ? '' : `, ${shortDate(fact.verifiedOn)}`;
    return `Confirmed${by}${on}`;
  }
  const who = fact.source === 'senior' ? (seniorName ?? 'She') : 'Family';
  return `${who} said this on ${shortDate(fact.notedOn)}. Not confirmed yet.`;
}

/**
 * purpose: The line above a family message: who sent it ("You" for the signed-in caregiver's
 *          own, which the server marks as mine), when, and for a caregiver's message whether the
 *          senior has seen it.
 * @param message: (FamilyMessage) The message.
 * @return: (string) For example "You, Nov 3 at 10:00 AM, seen" or "Mom, Nov 3 at 9:15 AM".
 */
export function messageMeta(message: FamilyMessage): string {
  const when = `${shortDate(message.sentDate)} at ${displayTime(message.sentTime)}`;
  const seen =
    message.senderKind === 'caregiver'
      ? message.seenAt === null
        ? ', not seen yet'
        : ', seen'
      : '';
  return `${message.mine ? 'You' : message.senderName}, ${when}${seen}`;
}

/**
 * purpose: What the add form shows after an add mutation, and whether it may clear its fields.
 *          Only text that is now stored as typed (or a fact that is now confirmed) clears the
 *          form; when the item is already stored with other text nothing was saved, so the typed
 *          text stays and the caregiver is told where to change the stored one.
 * @param kind: ('entry' | 'topic' | 'fact') What was added.
 * @param result: (AddResult) The add mutation's result.
 * @param name: (string) The entry's name or the topic's wording, for the message.
 * @return: (AddOutcome) Whether to clear the form, and the message to show (null for none).
 */
export function addOutcome(
  kind: 'entry' | 'topic' | 'fact',
  result: AddResult,
  name: string,
): AddOutcome {
  if (result.created) return { clear: true, message: null };
  if (result.confirmed) return { clear: true, message: { status: 'notice', text: 'Confirmed.' } };
  if (result.same || kind === 'fact') {
    return { clear: true, message: { status: 'notice', text: 'Already saved.' } };
  }
  const text =
    kind === 'entry'
      ? `Not saved: ${name} is already listed with other details. Tap them in the list above to change them.`
      : `Not saved: "${name}" already has guidance. Tap it in the list above to change it.`;
  return { clear: false, message: { status: 'error', text } };
}
