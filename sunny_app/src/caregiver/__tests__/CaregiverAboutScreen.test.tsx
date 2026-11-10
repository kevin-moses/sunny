// sunny_app/src/caregiver/__tests__/CaregiverAboutScreen.test.tsx
//
// Purpose: Render tests for the About tab with react-test-renderer, the four list queries
// mocked (useQueryWithStatus) and the network layer mocked (callMutation): an editor sees every
// section with its rows grouped and marked (an unconfirmed fact has a Confirm button that calls
// profile.verifyFact; a count of older unverified facts; "You" on the caller's own message);
// tapping a text opens its inline field and losing focus saves it through profile.updateEntry;
// Confirm tapped while correcting the fact saves the correction (profile.correctFact) instead of
// verifying the old text; Remove tapped while editing the row asks first, then removes without
// saving the open edit; the add form's button is disabled until the name has text and then calls
// profile.addEntry with the chosen category; the form is locked while the call runs; an add that
// finds other text stored keeps the typed text and says it was not saved; a viewer sees the same
// content with no forms, no Confirm and no remove buttons; and AboutInput reports focus to the
// tab bar and, on unmount, blur only if it still had focus. These stand in for seeing the screen
// on a device, which has not been done.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import { useQueryWithStatus } from '../../backend/convex';
import { AboutInput } from '../AboutComponents';
import { CaregiverAboutScreen } from '../CaregiverAboutScreen';
import { NoteFocusContext } from '../tabBarInset';

jest.mock('../../backend/convex', () => ({ convex: {}, useQueryWithStatus: jest.fn() }));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('../../theme/ThemeProvider', () => ({
  useTheme: () => ({
    accentColor: '#FA8539',
    cornerRadius: 12,
    buttonFontSize: 20,
    bodyFontSize: 17,
  }),
}));

const mockQuery = useQueryWithStatus as unknown as jest.Mock<(ref: unknown) => unknown>;
const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;

/** What a new add returns. */
const CREATED = { id: 'x', created: true, same: true, confirmed: false };

/** What each list query returns, by function name. */
const DATA: Record<string, unknown> = {
  'profile:listEntries': [
    { id: 'e1', category: 'person', name: 'Sarah', details: 'Daughter' },
    { id: 'e2', category: 'place', name: 'Library', details: null },
  ],
  'profile:listTopics': [{ id: 't1', topic: 'her husband', guidance: 'Be gentle.' }],
  'profile:listMemory': {
    facts: [
      {
        id: 'f1',
        fact: 'Likes tea',
        source: 'caregiver',
        verified: true,
        verifiedByName: 'Pat',
        notedOn: '2026-11-03',
        verifiedOn: '2026-11-03',
      },
      {
        id: 'f2',
        fact: 'Went to the markt',
        source: 'senior',
        verified: false,
        verifiedByName: null,
        notedOn: '2026-11-08',
        verifiedOn: null,
      },
    ],
    olderUnverified: 3,
  },
  'profile:listMessages': [
    {
      id: 'm2',
      senderKind: 'caregiver',
      mine: true,
      senderName: 'Pat',
      body: 'On my way',
      hasPhoto: false,
      hasAudio: false,
      sentAt: 3,
      sentDate: '2026-11-09',
      sentTime: '10:00',
      seenAt: null,
    },
    {
      id: 'm1',
      senderKind: 'senior',
      mine: false,
      senderName: 'Mom',
      body: 'I am home',
      hasPhoto: false,
      hasAudio: false,
      sentAt: 2,
      sentDate: '2026-11-09',
      sentTime: '09:15',
      seenAt: null,
    },
  ],
};

/** Renderers created by a test, unmounted afterwards. */
const mounted: ReactTestRenderer[] = [];

/**
 * purpose: Render the screen.
 * @param canEdit: (boolean) Whether the caregiver is an editor.
 * @return: (ReactTestRenderer) The renderer.
 */
function renderScreen(canEdit: boolean): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <CaregiverAboutScreen householdId={'h1' as never} seniorName="Mom" canEdit={canEdit} />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

/**
 * purpose: Every text string rendered under a node.
 * @param node: (ReactTestInstance) The node, for example renderer.root.
 * @return: (string[]) The texts.
 */
function texts(node: ReactTestInstance): string[] {
  return node
    .findAllByType(Text)
    .map((t) => [t.props.children].flat().join(''))
    .filter((s) => s !== '');
}

/**
 * purpose: The pressable with an accessibility label.
 * @param renderer: (ReactTestRenderer) The renderer.
 * @param label: (string) The label.
 * @return: (ReactTestInstance) The host element carrying the label and onPress.
 */
function byLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
}

/**
 * purpose: The text field with an accessibility label.
 * @param renderer: (ReactTestRenderer) The renderer.
 * @param label: (string) The label.
 * @return: (ReactTestInstance) The TextInput.
 */
function field(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find((n) => n.type === TextInput && n.props.accessibilityLabel === label);
}

/**
 * purpose: The add-entry form's Add button.
 * @param renderer: (ReactTestRenderer) The renderer.
 * @return: (ReactTestInstance) The button.
 */
function addButton(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findAll(
    (n) => n.props.accessibilityLabel === 'Add' && n.props.accessibilityState,
  )[0]!;
}

/**
 * purpose: The name and arguments of every mutation call so far.
 * @return: (Array<[string, unknown]>) Function names and arguments, in call order.
 */
function calls(): [string, unknown][] {
  return mockCall.mock.calls.map(([ref, args]) => [getFunctionName(ref as never), args]);
}

describe('CaregiverAboutScreen', () => {
  beforeEach(() => {
    mockCall.mockReset();
    mockCall.mockResolvedValue(CREATED);
    mockQuery.mockReset();
    mockQuery.mockImplementation((ref) => ({
      status: 'success',
      data: DATA[getFunctionName(ref as never)],
      error: undefined,
    }));
  });

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((r) => r.unmount());
    });
  });

  it('shows every section with grouped entries, marked facts and messages', () => {
    const shown = texts(renderScreen(true).root);
    for (const text of [
      'About Mom',
      'People',
      'Sarah',
      'Daughter',
      'Places',
      'Library',
      'Add details',
      'her husband',
      'Be gentle.',
      'Confirmed by Pat, Nov 3',
      'Mom said this on Nov 8. Not confirmed yet.',
      '3 older things Mom said are not listed.',
      'Mom, Nov 9 at 9:15 AM',
      'I am home',
      'You, Nov 9 at 10:00 AM, not seen yet',
    ]) {
      expect(shown).toContain(text);
    }
  });

  it('confirms an unconfirmed fact with one tap', async () => {
    const r = renderScreen(true);
    await act(async () => {
      await byLabel(r, 'Confirm: Went to the markt').props.onPress();
    });
    expect(calls()).toEqual([['profile:verifyFact', { householdId: 'h1', factId: 'f2' }]]);
  });

  it('Confirm while correcting the fact saves the correction instead of the old text', async () => {
    const r = renderScreen(true);
    act(() => {
      byLabel(r, 'Fact: Went to the markt').props.onPress();
    });
    act(() => {
      field(r, 'Fact').props.onChangeText('Went to the market');
    });
    await act(async () => {
      await byLabel(r, 'Confirm: Went to the markt').props.onPress();
    });
    expect(calls()).toEqual([
      ['profile:correctFact', { householdId: 'h1', factId: 'f2', fact: 'Went to the market' }],
    ]);
  });

  it('Confirm with the fact open but unchanged confirms it', async () => {
    const r = renderScreen(true);
    act(() => {
      byLabel(r, 'Fact: Went to the markt').props.onPress();
    });
    await act(async () => {
      await byLabel(r, 'Confirm: Went to the markt').props.onPress();
    });
    expect(calls()).toEqual([['profile:verifyFact', { householdId: 'h1', factId: 'f2' }]]);
  });

  it('edits a name inline and saves it when the field loses focus', async () => {
    const r = renderScreen(true);
    act(() => {
      byLabel(r, 'Name: Sarah').props.onPress();
    });
    const name = field(r, 'Name');
    expect(name.props.defaultValue).toBe('Sarah');
    await act(async () => {
      name.props.onChangeText('Sarah Lee');
      name.props.onBlur();
    });
    expect(calls()).toEqual([
      ['profile:updateEntry', { householdId: 'h1', entryId: 'e1', name: 'Sarah Lee' }],
    ]);
  });

  it('Remove while editing the row asks first, then removes without saving the edit', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = renderScreen(true);
    act(() => {
      byLabel(r, 'Name: Sarah').props.onPress();
    });
    act(() => {
      field(r, 'Name').props.onChangeText('Sarah Lee');
    });
    act(() => {
      byLabel(r, 'Remove Sarah').props.onPress();
    });
    expect(r.root.findAllByType(TextInput).some((n) => n.props.accessibilityLabel === 'Name')).toBe(
      false,
    );
    expect(mockCall).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((b) => b.text === 'Remove')!.onPress!();
    });
    expect(calls()).toEqual([['profile:removeEntry', { householdId: 'h1', entryId: 'e1' }]]);
    alert.mockRestore();
  });

  it('a cancelled Remove keeps the held edit for when the text is reopened', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = renderScreen(true);
    act(() => {
      byLabel(r, 'Name: Sarah').props.onPress();
    });
    act(() => {
      field(r, 'Name').props.onChangeText('Sarah Lee');
    });
    act(() => {
      byLabel(r, 'Remove Sarah').props.onPress();
    });
    act(() => {
      byLabel(r, 'Name: Sarah').props.onPress();
    });
    expect(field(r, 'Name').props.defaultValue).toBe('Sarah Lee');
    expect(mockCall).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('enables Add once the name has text and adds with the chosen category', async () => {
    const r = renderScreen(true);
    expect(addButton(r).props.accessibilityState.disabled).toBe(true);
    const doctorChip = r.root
      .findAll(
        (n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function',
      )
      .find((n) => texts(n).includes('Doctor'))!;
    act(() => {
      doctorChip.props.onPress();
    });
    act(() => {
      field(r, 'Name, for example Sarah').props.onChangeText('  Dr Lee ');
    });
    expect(addButton(r).props.accessibilityState.disabled).toBe(false);
    await act(async () => {
      addButton(r).props.onPress();
    });
    expect(calls()).toEqual([
      [
        'profile:addEntry',
        { householdId: 'h1', category: 'doctor', name: 'Dr Lee', details: undefined },
      ],
    ]);
    expect(field(r, 'Name, for example Sarah').props.value).toBe('');
  });

  it('locks the add form while the call runs', async () => {
    let resolve!: (v: unknown) => void;
    mockCall.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const r = renderScreen(true);
    act(() => {
      field(r, 'Name, for example Sarah').props.onChangeText('Ben');
    });
    act(() => {
      addButton(r).props.onPress();
    });
    expect(field(r, 'Name, for example Sarah').props.editable).toBe(false);
    await act(async () => {
      resolve(CREATED);
    });
    expect(field(r, 'Name, for example Sarah').props.editable).toBe(true);
  });

  it('keeps typed text and says it was not saved when the entry exists with other details', async () => {
    mockCall.mockResolvedValue({ id: 'e1', created: false, same: false, confirmed: false });
    const r = renderScreen(true);
    act(() => {
      field(r, 'Name, for example Sarah').props.onChangeText('Sarah');
      field(r, 'Details, for example her daughter, lives nearby').props.onChangeText('Neighbor');
    });
    await act(async () => {
      addButton(r).props.onPress();
    });
    expect(field(r, 'Name, for example Sarah').props.value).toBe('Sarah');
    expect(field(r, 'Details, for example her daughter, lives nearby').props.value).toBe(
      'Neighbor',
    );
    expect(texts(r.root)).toContain(
      'Not saved: Sarah is already listed with other details. Tap them in the list above to change them.',
    );
  });

  it('gives every tappable text a 44pt target', () => {
    const r = renderScreen(true);
    for (const label of ['Name: Sarah', 'Add details', 'Topic: her husband']) {
      const styleProp = byLabel(r, label).props.style;
      const resolved: unknown =
        typeof styleProp === 'function' ? styleProp({ pressed: false }) : styleProp;
      const styles = [resolved].flat(Infinity) as ({ minHeight?: number } | false)[];
      expect(styles.some((s) => s && (s.minHeight ?? 0) >= 44)).toBe(true);
    }
  });

  it('shows a viewer everything read only', () => {
    const r = renderScreen(false);
    const shown = texts(r.root);
    expect(shown).toContain('Viewers can read this but cannot change it.');
    expect(shown).toContain('Mom said this on Nov 8. Not confirmed yet.');
    expect(shown).not.toContain('Add details');
    expect(r.root.findAllByType(TextInput)).toHaveLength(0);
    expect(
      r.root.findAll(
        (n) =>
          typeof n.props.accessibilityLabel === 'string' &&
          /^(Remove|Confirm)/.test(n.props.accessibilityLabel),
      ),
    ).toHaveLength(0);
  });
});

describe('AboutInput focus reporting', () => {
  /**
   * purpose: Render two AboutInputs under a focus reporter.
   * @param showA: (boolean) Whether the first input is mounted.
   * @param report: ((focused: boolean) => void) The reporter.
   * @return: (JSX.Element) The tree.
   */
  const Tree = ({ showA, report }: { showA: boolean; report: (focused: boolean) => void }) => (
    <NoteFocusContext.Provider value={report}>
      {showA && <AboutInput accessibilityLabel="A" />}
      <AboutInput accessibilityLabel="B" />
    </NoteFocusContext.Provider>
  );

  it('does not report blur when an input that lost focus unmounts', () => {
    const report = jest.fn<(focused: boolean) => void>();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<Tree showA report={report} />);
    });
    const input = (label: string) =>
      r.root.find((n) => n.type === TextInput && n.props.accessibilityLabel === label);
    act(() => {
      input('A').props.onFocus({});
      input('A').props.onBlur({});
      input('B').props.onFocus({});
    });
    act(() => {
      r.update(<Tree showA={false} report={report} />);
    });
    expect(report.mock.calls.map((c) => c[0])).toEqual([true, false, true]);
    act(() => r.unmount());
    expect(report.mock.calls.map((c) => c[0])).toEqual([true, false, true, false]);
  });
});
