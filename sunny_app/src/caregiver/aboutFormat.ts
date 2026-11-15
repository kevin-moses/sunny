import type { FunctionReturnType } from 'convex/server';

import type { api, FactId, ProfileEntryId, TopicId } from '../backend/convexApi';
import { displayTime } from '../day/format';
import { dayOfMonth, monthName, parseLocalDate } from '../day/localDate';
import type { OLDER_COUNT_LIMIT as BACKEND_OLDER_COUNT_LIMIT } from '../../../sunny_backend/convex/profile';

export type ProfileEntry = FunctionReturnType<typeof api.profile.listEntries>[number];
export type SensitiveTopic = FunctionReturnType<typeof api.profile.listTopics>[number];
export type MemoryList = FunctionReturnType<typeof api.profile.listMemory>;
export type MemoryFact = MemoryList['facts'][number];
export type AddResult = Pick<
  FunctionReturnType<typeof api.profile.addEntry>,
  'created' | 'same' | 'confirmed'
>;

export interface AddOutcome {
  clear: boolean;
  message: { status: 'notice' | 'error'; text: string } | null;
}
export type FamilyMessage = FunctionReturnType<typeof api.profile.listMessages>[number];
export type LifeCategory = ProfileEntry['category'];

const TAB_NAME_MAX = 8;

export const OLDER_COUNT_LIMIT: typeof BACKEND_OLDER_COUNT_LIMIT = 500;

export function olderUnverifiedLine(count: number, name: string): string {
  const amount = count >= OLDER_COUNT_LIMIT ? `${count} or more` : String(count);
  return `${amount} older ${count === 1 ? 'thing' : 'things'} ${name} said ${count === 1 ? 'is' : 'are'} not listed.`;
}

export const CATEGORIES: readonly { category: LifeCategory; title: string; chip: string }[] = [
  { category: 'person', title: 'People', chip: 'Person' },
  { category: 'place', title: 'Places', chip: 'Place' },
  { category: 'doctor', title: 'Doctors', chip: 'Doctor' },
  { category: 'habit', title: 'Habits', chip: 'Habit' },
  { category: 'interest', title: 'Interests', chip: 'Interest' },
  { category: 'preference', title: 'Preferences', chip: 'Preference' },
  { category: 'other', title: 'Other', chip: 'Other' },
];

export interface EntryGroup {
  category: LifeCategory;
  title: string;
  entries: ProfileEntry[];
}

export type FieldTarget =
  | { kind: 'entryName'; id: ProfileEntryId; current: string }
  | { kind: 'entryDetails'; id: ProfileEntryId; current: string | null }
  | { kind: 'topic'; id: TopicId; current: string }
  | { kind: 'guidance'; id: TopicId; current: string }
  | { kind: 'fact'; id: FactId; current: string };

export type RowRef =
  | { kind: 'entry'; id: ProfileEntryId }
  | { kind: 'topic'; id: TopicId }
  | { kind: 'fact'; id: FactId };

export type DraftDecision = { save: false } | { save: true; value: string | null };

export function aboutTabLabel(seniorName: string | null): string {
  const name = seniorName?.trim() ?? '';
  return name !== '' && name.length <= TAB_NAME_MAX ? `About ${name}` : 'About';
}

export function groupEntries(entries: ProfileEntry[]): EntryGroup[] {
  return CATEGORIES.map(({ category, title }) => ({
    category,
    title,
    entries: entries.filter((e) => e.category === category),
  })).filter((group) => group.entries.length > 0);
}

export function fieldKey(target: FieldTarget): string {
  return `${target.kind}:${target.id}`;
}

export function rowKey(row: RowRef): string {
  return `${row.kind}:${row.id}`;
}

function fieldRow(target: FieldTarget): RowRef {
  if (target.kind === 'entryName' || target.kind === 'entryDetails') {
    return { kind: 'entry', id: target.id };
  }
  if (target.kind === 'topic' || target.kind === 'guidance')
    return { kind: 'topic', id: target.id };
  return { kind: 'fact', id: target.id };
}

export function fieldRowKey(target: FieldTarget): string {
  return rowKey(fieldRow(target));
}

export function draftToSave(draft: string, target: FieldTarget): DraftDecision {
  const text = draft.trim();
  if (text === (target.current ?? '').trim()) return { save: false };
  if (text !== '') return { save: true, value: text };
  return target.kind === 'entryDetails' ? { save: true, value: null } : { save: false };
}

export function shortDate(localDate: string): string {
  const time = parseLocalDate(localDate);
  if (time === null) return localDate;
  return `${monthName(time).slice(0, 3)} ${dayOfMonth(time)}`;
}

export function factStatus(fact: MemoryFact, seniorName: string | null): string {
  if (fact.verified) {
    const by = fact.verifiedByName === null ? '' : ` by ${fact.verifiedByName}`;
    const on = fact.verifiedOn === null ? '' : `, ${shortDate(fact.verifiedOn)}`;
    return `Confirmed${by}${on}`;
  }
  const who = fact.source === 'senior' ? (seniorName ?? 'She') : 'Family';
  return `${who} said this on ${shortDate(fact.notedOn)}. Not confirmed yet.`;
}

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
