// sunny_app/src/caregiver/__tests__/CaregiverChatScreen.test.tsx
//
// Purpose: Render tests for the Chat tab with react-test-renderer, the transcript query mocked
// at the Convex hook (useQueryWithStatus) and the network at callMutation: the thread is read
// from agentRequests.transcript for editors and viewers alike; a digest post shows in time order
// as a Sunny message under a "Daily summary" label with the day; an editor's reply after it is
// an ordinary agentRequests.request with continueLatest; a viewer sees the posts read-only (the
// note instead of the input).
//
// Last modified: 2026-11-14

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import { useQueryWithStatus } from '../../backend/convex';
import type { HouseholdId } from '../../backend/convexApi';
import { AgentMessage } from '../../components/ChatMessages';
import { CaregiverChatScreen } from '../CaregiverChatScreen';

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

const mockQuery = useQueryWithStatus as unknown as jest.Mock<
  (ref: unknown, args: unknown) => unknown
>;
const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;

const HOUSEHOLD = 'household_1' as HouseholdId;

/** The thread as agentRequests.transcript returns it: newest first. */
const THREAD = [
  {
    type: 'request',
    id: 'r2',
    householdId: HOUSEHOLD,
    requestedBy: 'user_pat',
    requestedByName: 'Pat',
    message: "Why was the 8 o'clock late?",
    continueRequestId: null,
    status: 'succeeded',
    reply: 'She confirmed it at 9:10 after a late breakfast.',
    error: null,
    createdAt: 3,
    finishedAt: 4,
  },
  {
    type: 'post',
    id: 'p1',
    householdId: HOUSEHOLD,
    kind: 'digest',
    body: 'Morning pills: confirmed late at 9:10.',
    localDate: '2026-11-13',
    createdAt: 2,
  },
  {
    type: 'request',
    id: 'r1',
    householdId: HOUSEHOLD,
    requestedBy: 'user_max',
    requestedByName: 'Max',
    message: 'Is lunch on the calendar?',
    continueRequestId: null,
    status: 'succeeded',
    reply: 'Yes, at noon.',
    error: null,
    createdAt: 1,
    finishedAt: 1,
  },
];

/**
 * purpose: Render the Chat tab.
 * @param canSend: (boolean) Whether the caregiver may message Sunny.
 * @param thread: (unknown[]) What the transcript query returns.
 * @return: (Promise<ReactTestRenderer>) The renderer.
 */
async function renderChat(canSend: boolean, thread: unknown[] = THREAD) {
  mockQuery.mockReturnValue({ status: 'success', data: thread, error: undefined });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <CaregiverChatScreen
        householdId={HOUSEHOLD}
        seniorName="Mom"
        canSend={canSend}
        userId="user_pat"
      />,
    );
  });
  return renderer!;
}

/**
 * purpose: Every text on screen, in order.
 * @param renderer: (ReactTestRenderer) The rendered screen.
 * @return: (string[]) The texts.
 */
function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((t) => String(t.props.children));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCall.mockResolvedValue('r3');
});

describe('CaregiverChatScreen', () => {
  it('reads the thread from agentRequests.transcript', async () => {
    await renderChat(true);
    const [ref, args] = mockQuery.mock.calls[0]!;
    expect(getFunctionName(ref as never)).toBe('agentRequests:transcript');
    expect(args).toEqual({ householdId: HOUSEHOLD, limit: 20 });
  });

  it('shows the digest in time order as a labelled Sunny message', async () => {
    const renderer = await renderChat(true);
    const shown = texts(renderer);
    const order = [
      'Is lunch on the calendar?',
      'Yes, at noon.',
      'Daily summary, Friday, November 13',
      'Morning pills: confirmed late at 9:10.',
      "Why was the 8 o'clock late?",
      'She confirmed it at 9:10 after a late breakfast.',
    ].map((text) => shown.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const digest = renderer.root
      .findAllByType(AgentMessage)
      .find((m) => m.props.text === 'Morning pills: confirmed late at 9:10.');
    expect(digest?.props.label).toBe('Daily summary, Friday, November 13');
  });

  it('a reply after the digest is an ordinary request in the same conversation', async () => {
    const renderer = await renderChat(true);
    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('Why was it late?');
    });
    const send = renderer.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Send message' && node.props.onPress !== undefined,
    )[0];
    await act(async () => {
      send!.props.onPress();
    });
    expect(getFunctionName(mockCall.mock.calls[0]![0] as never)).toBe('agentRequests:request');
    expect(mockCall.mock.calls[0]![1]).toEqual({
      householdId: HOUSEHOLD,
      message: 'Why was it late?',
      continueLatest: true,
    });
  });

  it('a viewer sees the digest posts read-only', async () => {
    const posts = THREAD.filter((item) => item.type === 'post');
    const renderer = await renderChat(false, posts);
    expect(mockQuery.mock.calls[0]![1]).toEqual({ householdId: HOUSEHOLD, limit: 20 });
    expect(texts(renderer)).toContain('Morning pills: confirmed late at 9:10.');
    expect(renderer.root.findAllByType(TextInput)).toHaveLength(0);
    expect(texts(renderer).some((t) => t.startsWith('Viewers can read'))).toBe(true);
  });
});
