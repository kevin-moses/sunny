// sunny_app/src/caregiver/__tests__/CaregiverChatScreen.test.tsx
//
// Purpose: Render tests for the Chat tab with react-test-renderer, the transcript query mocked
// at the Convex hook (useQueryWithStatus) and the network at callMutation: the thread is read
// from agentRequests.transcript for editors and viewers alike; a digest post shows in time order
// as a Sunny message under a "Daily summary" label with the day; an editor's reply after it is
// an ordinary agentRequests.request with continueLatest; a viewer sees the posts read-only (the
// note instead of the input). Wording cards: one per task under the reply (label line, then
// sentence line, read by VoiceOver as one), no button for a task without a time, play speaks
// with the display's voice and a second tap stops, hiding the tab stops, viewers see none.
//
// Last modified: 2026-11-14

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SpeechOptions } from 'expo-speech';

import { callMutation } from '../../backend/api';
import { useQueryWithStatus } from '../../backend/convex';
import type { HouseholdId } from '../../backend/convexApi';
import { AgentMessage } from '../../components/ChatMessages';
import { CaregiverChatScreen } from '../CaregiverChatScreen';
import { PLAY_LABEL, STOP_LABEL, WordingCard } from '../WordingCard';

jest.mock('../../backend/convex', () => ({ convex: {}, useQueryWithStatus: jest.fn() }));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

/** What the screen asked expo-speech to say, with its options (callbacks included). */
const mockSpoken: { text: string; options: SpeechOptions }[] = [];
const mockSpeechStop = jest.fn();

jest.mock('expo-speech', () => ({
  speak: (text: string, options: SpeechOptions) => mockSpoken.push({ text, options }),
  stop: () => mockSpeechStop(),
}));

jest.mock('expo-audio', () => ({ setAudioModeAsync: () => Promise.resolve() }));

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
    wording: [],
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
    wording: [],
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
    renderer = create(<Chat canSend={canSend} active />);
  });
  return renderer!;
}

/**
 * purpose: The Chat tab with fixed household, senior and user.
 * @param props: ({ canSend, active }) Whether the caregiver may send and the tab shows.
 * @return: (JSX.Element) The screen.
 */
function Chat({ canSend, active }: { canSend: boolean; active: boolean }) {
  return (
    <CaregiverChatScreen
      householdId={HOUSEHOLD}
      seniorName="Mom"
      canSend={canSend}
      userId="user_pat"
      active={active}
    />
  );
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
  mockSpoken.length = 0;
  mockCall.mockResolvedValue('r3');
});

/** The sentence the display speaks for the pills task in WORDING_THREAD. */
const SENTENCE = "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.";

/** A thread whose one request added two tasks: a timed one and an anytime one. */
const WORDING_THREAD = [
  {
    ...THREAD[2],
    id: 'r9',
    wording: [
      { taskId: 't1', label: 'Morning pills', time: '8:00', sentence: SENTENCE },
      { taskId: 't2', label: 'Water the plants', time: 'Anytime', sentence: null },
    ],
  },
];

/**
 * purpose: The wording card buttons on screen.
 * @param renderer: (ReactTestRenderer) The rendered screen.
 * @return: The pressable nodes labelled play or stop.
 */
function cardButtons(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      (node.props.accessibilityLabel === PLAY_LABEL ||
        node.props.accessibilityLabel === STOP_LABEL) &&
      node.props.onPress !== undefined,
  );
}

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

describe('wording cards', () => {
  it('shows a card per task under the reply, reading as label then sentence', async () => {
    const renderer = await renderChat(true, WORDING_THREAD);
    const shown = texts(renderer);
    const order = [
      'Yes, at noon.',
      'On the display',
      '8:00',
      'Morning pills',
      'Sunny says',
      SENTENCE,
    ];
    const at = order.map((text) => shown.indexOf(text));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const cards = renderer.root.findAllByType(WordingCard);
    expect(cards).toHaveLength(2);
    const labels = renderer.root
      .findAll((node) => typeof node.props.accessibilityLabel === 'string' && node.props.accessible)
      .map((node) => node.props.accessibilityLabel as string);
    expect(labels).toContain(`On the display: 8:00 Morning pills. Sunny says: ${SENTENCE}`);
  });

  it('a task without a time says it is not spoken and has no button', async () => {
    const renderer = await renderChat(true, WORDING_THREAD);
    expect(texts(renderer)).toContain('Nothing. Tasks without a time are not announced.');
    expect(cardButtons(renderer)).toHaveLength(1);
  });

  it('play speaks the sentence with the display voice; tapping again stops it', async () => {
    const renderer = await renderChat(true, WORDING_THREAD);
    await act(async () => {
      cardButtons(renderer)[0]!.props.onPress();
    });
    expect(mockSpoken.map((s) => s.text)).toEqual([SENTENCE]);
    expect(mockSpoken[0]!.options).toMatchObject({ language: 'en-US', rate: 0.8 });
    expect(cardButtons(renderer)[0]!.props.accessibilityLabel).toBe(STOP_LABEL);
    await act(async () => {
      cardButtons(renderer)[0]!.props.onPress();
    });
    expect(mockSpeechStop).toHaveBeenCalledTimes(1);
    expect(cardButtons(renderer)[0]!.props.accessibilityLabel).toBe(PLAY_LABEL);
  });

  it('leaving the tab stops the sentence', async () => {
    const renderer = await renderChat(true, WORDING_THREAD);
    await act(async () => {
      cardButtons(renderer)[0]!.props.onPress();
    });
    await act(async () => {
      renderer.update(<Chat canSend active={false} />);
    });
    expect(mockSpeechStop).toHaveBeenCalledTimes(1);
    expect(cardButtons(renderer)[0]!.props.accessibilityLabel).toBe(PLAY_LABEL);
  });

  it('a viewer, who gets posts only, sees no cards', async () => {
    const posts = THREAD.filter((item) => item.type === 'post');
    const renderer = await renderChat(false, posts);
    expect(renderer.root.findAllByType(WordingCard)).toHaveLength(0);
  });
});
