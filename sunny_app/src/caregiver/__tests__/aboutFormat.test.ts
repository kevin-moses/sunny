// sunny_app/src/caregiver/__tests__/aboutFormat.test.ts
//
// Purpose: Unit tests for the About tab helpers: the tab label (named only when it fits), the
// life profile grouped by category in the backend's order (empty categories left out), field and
// row keys, what closing an inline editor saves (unchanged, blank required, cleared details,
// trimmed text), short dates, the fact status line (confirmed with or without a name, said by the
// senior and not confirmed) and the message meta line (you or the sender, local time, seen state).
//
// Last modified: 2026-11-09

import { describe, expect, it } from '@jest/globals';

import {
  aboutTabLabel,
  draftToSave,
  factStatus,
  fieldKey,
  fieldRowKey,
  groupEntries,
  messageMeta,
  shortDate,
  type FamilyMessage,
  type FieldTarget,
  type MemoryFact,
  type ProfileEntry,
} from '../aboutFormat';

/**
 * purpose: A life profile entry fixture.
 * @param id: (string) Id.
 * @param category: (ProfileEntry['category']) Category.
 * @param name: (string) Name.
 * @return: (ProfileEntry) The entry.
 */
function entry(id: string, category: ProfileEntry['category'], name: string): ProfileEntry {
  return { id: id as ProfileEntry['id'], category, name, details: null };
}

/**
 * purpose: A memory fact fixture; confirmed by Pat on 2026-11-03 unless overridden.
 * @param fields: (Partial<MemoryFact>) Overrides.
 * @return: (MemoryFact) The fact.
 */
function fact(fields: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'f1' as MemoryFact['id'],
    fact: 'Likes tea',
    source: 'caregiver',
    verified: true,
    verifiedByName: 'Pat',
    notedOn: '2026-11-03',
    verifiedOn: '2026-11-03',
    ...fields,
  };
}

/**
 * purpose: A family message fixture from Pat, sent 2026-11-03 at 14:05, not seen.
 * @param fields: (Partial<FamilyMessage>) Overrides.
 * @return: (FamilyMessage) The message.
 */
function message(fields: Partial<FamilyMessage> = {}): FamilyMessage {
  return {
    id: 'm1' as FamilyMessage['id'],
    senderKind: 'caregiver',
    senderUserId: 'pat',
    senderName: 'Pat',
    body: 'Hi',
    hasPhoto: false,
    hasAudio: false,
    sentAt: 0,
    sentDate: '2026-11-03',
    sentTime: '14:05',
    seenAt: null,
    ...fields,
  };
}

const NAME: FieldTarget = { kind: 'entryName', id: 'e1' as never, current: 'Sarah' };
const DETAILS: FieldTarget = { kind: 'entryDetails', id: 'e1' as never, current: 'Daughter' };
const NO_DETAILS: FieldTarget = { kind: 'entryDetails', id: 'e1' as never, current: null };

describe('aboutTabLabel', () => {
  it('names a short senior name', () => {
    expect(aboutTabLabel('Mom')).toBe('About Mom');
    expect(aboutTabLabel(' Margaret ')).toBe('About Margaret');
  });

  it('falls back to About for a long, blank or unknown name', () => {
    expect(aboutTabLabel('Elizabeth')).toBe('About');
    expect(aboutTabLabel('  ')).toBe('About');
    expect(aboutTabLabel(null)).toBe('About');
  });
});

describe('groupEntries', () => {
  it('groups by category in the backend order, keeping order within a group', () => {
    const groups = groupEntries([
      entry('1', 'person', 'Ben'),
      entry('2', 'person', 'Sarah'),
      entry('3', 'doctor', 'Dr Lee'),
      entry('4', 'place', 'Library'),
    ]);
    expect(groups.map((g) => [g.title, g.entries.map((e) => e.name)])).toEqual([
      ['People', ['Ben', 'Sarah']],
      ['Places', ['Library']],
      ['Doctors', ['Dr Lee']],
    ]);
  });

  it('returns no groups for no entries', () => {
    expect(groupEntries([])).toEqual([]);
  });
});

describe('field keys', () => {
  it('keys each text and maps it to its row', () => {
    expect(fieldKey(NAME)).toBe('entryName:e1');
    expect(fieldRowKey(NAME)).toBe('entry:e1');
    expect(fieldRowKey(DETAILS)).toBe('entry:e1');
    expect(fieldRowKey({ kind: 'guidance', id: 't1' as never, current: 'G' })).toBe('topic:t1');
    expect(fieldRowKey({ kind: 'topic', id: 't1' as never, current: 'T' })).toBe('topic:t1');
    expect(fieldRowKey({ kind: 'fact', id: 'f1' as never, current: 'F' })).toBe('fact:f1');
  });
});

describe('draftToSave', () => {
  it('saves nothing when the trimmed text is unchanged', () => {
    expect(draftToSave('  Sarah ', NAME)).toEqual({ save: false });
    expect(draftToSave('  ', NO_DETAILS)).toEqual({ save: false });
  });

  it('saves the trimmed text when it changed', () => {
    expect(draftToSave(' Sarah Lee ', NAME)).toEqual({ save: true, value: 'Sarah Lee' });
    expect(draftToSave('Neighbor', NO_DETAILS)).toEqual({ save: true, value: 'Neighbor' });
  });

  it('clears optional details left blank', () => {
    expect(draftToSave(' ', DETAILS)).toEqual({ save: true, value: null });
  });

  it('keeps a required text left blank', () => {
    expect(draftToSave('', NAME)).toEqual({ save: false });
    expect(draftToSave(' ', { kind: 'fact', id: 'f1' as never, current: 'F' })).toEqual({
      save: false,
    });
  });
});

describe('shortDate', () => {
  it('shows the short month and day', () => {
    expect(shortDate('2026-11-03')).toBe('Nov 3');
    expect(shortDate('2027-05-14')).toBe('May 14');
  });

  it('returns an invalid date unchanged', () => {
    expect(shortDate('soon')).toBe('soon');
  });
});

describe('factStatus', () => {
  it('says who confirmed a fact and when', () => {
    expect(factStatus(fact(), 'Mom')).toBe('Confirmed by Pat, Nov 3');
  });

  it('leaves out a confirmer who is no longer a member', () => {
    expect(factStatus(fact({ verifiedByName: null }), 'Mom')).toBe('Confirmed, Nov 3');
  });

  it('marks what the senior said as not confirmed', () => {
    const said = fact({
      source: 'senior',
      verified: false,
      verifiedByName: null,
      verifiedOn: null,
    });
    expect(factStatus(said, 'Mom')).toBe('Mom said this on Nov 3. Not confirmed yet.');
    expect(factStatus(said, null)).toBe('She said this on Nov 3. Not confirmed yet.');
  });
});

describe('messageMeta', () => {
  it('says You for the signed-in caregiver, with time and seen state', () => {
    expect(messageMeta(message(), 'pat')).toBe('You, Nov 3 at 2:05 PM, not seen yet');
    expect(messageMeta(message({ seenAt: 5 }), 'pat')).toBe('You, Nov 3 at 2:05 PM, seen');
  });

  it("names another caregiver and the senior, with no seen state for the senior's", () => {
    expect(messageMeta(message(), 'max')).toBe('Pat, Nov 3 at 2:05 PM, not seen yet');
    expect(
      messageMeta(
        message({ senderKind: 'senior', senderUserId: null, senderName: 'Mom', sentTime: '09:15' }),
        'pat',
      ),
    ).toBe('Mom, Nov 3 at 9:15 AM');
  });

  it('names the sender when the signed-in user is unknown', () => {
    expect(messageMeta(message(), null)).toBe('Pat, Nov 3 at 2:05 PM, not seen yet');
  });
});
