// sunny_app/src/caregiver/__tests__/CaregiverAboutScreen.test.tsx
//
// Purpose: Render tests for the About tab with react-test-renderer, the four list queries
// mocked (useQueryWithStatus) and the network layer mocked (callMutation): an editor sees every
// section with its rows grouped and marked (an unconfirmed fact has a Confirm button that calls
// profile.verifyFact), tapping a text opens its inline field and losing focus saves it through
// profile.updateEntry, removing asks for confirmation first, the add form's button is disabled
// until the name has text and then calls profile.addEntry with the chosen category, and a viewer
// sees the same content with no forms, no Confirm and no remove buttons. These stand in for
// seeing the screen on a device, which has not been done.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import { useQueryWithStatus } from '../../backend/convex';
import { CaregiverAboutScreen } from '../CaregiverAboutScreen';

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

/** What each list query returns, by function name. */
const DATA: Record<string, unknown[]> = {
  'profile:listEntries': [
    { id: 'e1', category: 'person', name: 'Sarah', details: 'Daughter' },
    { id: 'e2', category: 'place', name: 'Library', details: null },
  ],
  'profile:listTopics': [{ id: 't1', topic: 'her husband', guidance: 'Be gentle.' }],
  'profile:listMemory': [
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
      fact: 'Went to the market',
      source: 'senior',
      verified: false,
      verifiedByName: null,
      notedOn: '2026-11-08',
      verifiedOn: null,
    },
  ],
  'profile:listMessages': [
    {
      id: 'm1',
      senderKind: 'senior',
      senderUserId: null,
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
      <CaregiverAboutScreen
        householdId={'h1' as never}
        seniorName="Mom"
        canEdit={canEdit}
        userId="pat"
      />,
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
 * purpose: The name and arguments of the nth mutation call.
 * @param n: (number) Call index.
 * @return: ([string, unknown]) Function name and arguments.
 */
function callAt(n: number): [string, unknown] {
  const [ref, args] = mockCall.mock.calls[n]!;
  return [getFunctionName(ref as never), args];
}

describe('CaregiverAboutScreen', () => {
  beforeEach(() => {
    mockCall.mockReset();
    mockCall.mockResolvedValue({ created: true });
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

  it('shows every section with grouped entries and marked facts', () => {
    const shown = texts(renderScreen(true).root);
    for (const text of [
      'About Mom',
      'People and places',
      'People',
      'Sarah',
      'Daughter',
      'Places',
      'Library',
      'Add details',
      'Hard questions',
      'her husband',
      'Be gentle.',
      'What Sunny remembers',
      'Confirmed by Pat, Nov 3',
      'Mom said this on Nov 8. Not confirmed yet.',
      'Messages',
      'Mom, Nov 9 at 9:15 AM',
      'I am home',
    ]) {
      expect(shown).toContain(text);
    }
  });

  it('confirms an unconfirmed fact with one tap', async () => {
    const r = renderScreen(true);
    await act(async () => {
      byLabel(r, 'Confirm: Went to the market').props.onPress();
    });
    expect(callAt(0)).toEqual(['profile:verifyFact', { householdId: 'h1', factId: 'f2' }]);
  });

  it('edits a name inline and saves it when the field loses focus', async () => {
    const r = renderScreen(true);
    act(() => {
      byLabel(r, 'Name: Sarah').props.onPress();
    });
    const field = r.root.find((n) => n.type === TextInput && n.props.accessibilityLabel === 'Name');
    expect(field.props.defaultValue).toBe('Sarah');
    await act(async () => {
      field.props.onChangeText('Sarah Lee');
      field.props.onBlur();
    });
    expect(callAt(0)).toEqual([
      'profile:updateEntry',
      { householdId: 'h1', entryId: 'e1', name: 'Sarah Lee' },
    ]);
  });

  it('asks before removing, and removes on confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = renderScreen(true);
    act(() => {
      byLabel(r, 'Remove Sarah').props.onPress();
    });
    expect(mockCall).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((b) => b.text === 'Remove')!.onPress!();
    });
    expect(callAt(0)).toEqual(['profile:removeEntry', { householdId: 'h1', entryId: 'e1' }]);
    alert.mockRestore();
  });

  it('enables Add once the name has text and adds with the chosen category', async () => {
    const r = renderScreen(true);
    const addButton = () =>
      r.root.findAll((n) => n.props.accessibilityLabel === 'Add' && n.props.accessibilityState)[0]!;
    expect(addButton().props.accessibilityState.disabled).toBe(true);
    const doctorChip = r.root
      .findAll(
        (n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function',
      )
      .find((n) => texts(n).includes('Doctor'))!;
    act(() => {
      doctorChip.props.onPress();
    });
    const nameField = r.root.find(
      (n) => n.type === TextInput && n.props.accessibilityLabel === 'Name, for example Sarah',
    );
    act(() => {
      nameField.props.onChangeText('  Dr Lee ');
    });
    expect(addButton().props.accessibilityState.disabled).toBe(false);
    await act(async () => {
      addButton().props.onPress();
    });
    expect(callAt(0)).toEqual([
      'profile:addEntry',
      { householdId: 'h1', category: 'doctor', name: 'Dr Lee', details: undefined },
    ]);
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
