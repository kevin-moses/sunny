import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { AccessibilityInfo, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SpeechOptions } from 'expo-speech';

import { callMutation } from '../../backend/api';
import { useQueryWithStatus } from '../../backend/convex';
import type { HouseholdId } from '../../backend/convexApi';
import { AgentMessage } from '../../components/ChatMessages';
import { CaregiverChatScreen } from '../CaregiverChatScreen';
import { PLAY_FAILED_TEXT, PLAY_LABEL, STOP_LABEL, WordingCard } from '../WordingCard';

jest.mock('../../backend/convex', () => ({ convex: {}, useQueryWithStatus: jest.fn() }));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

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

async function renderChat(canSend: boolean, thread: unknown[] = THREAD) {
  mockQuery.mockReturnValue({ status: 'success', data: thread, error: undefined });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Chat canSend={canSend} active />);
  });
  return renderer!;
}

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

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((t) => String(t.props.children));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpoken.length = 0;
  mockCall.mockResolvedValue('r3');
});

const SENTENCE = "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.";

const WORDING_THREAD = [
  {
    ...THREAD[2],
    id: 'r9',
    wording: [
      {
        taskId: 't1',
        label: 'Morning pills',
        time: '8:00',
        times: ['08:00', '20:00'],
        sentence: SENTENCE,
      },
      { taskId: 't2', label: 'Water the plants', time: 'Anytime', times: [], sentence: null },
    ],
  },
];

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

  it('shows a mail post as a quiet header above its body, keeping the line breaks', async () => {
    const mail = {
      type: 'post',
      id: 'p2',
      householdId: HOUSEHOLD,
      kind: 'mail',
      body: [
        'From: Dr Lee <office@clinic.example> (verified sender)',
        'Subject: Checkup',
        'Received: Friday, November 13 at 9:00 AM',
        '',
        'Added to the calendar:',
        'Checkup, Tuesday at 2:00 PM.',
      ].join('\n'),
      localDate: '2026-11-13',
      createdAt: 5,
    };
    const renderer = await renderChat(true, [mail]);
    const message = renderer.root.findByType(AgentMessage);
    expect(message.props.label).toBe(
      [
        'From: Dr Lee <office@clinic.example> (verified sender)',
        'Subject: Checkup',
        'Received: Friday, November 13 at 9:00 AM',
      ].join('\n'),
    );
    expect(message.props.text).toBe('Added to the calendar:\nCheckup, Tuesday at 2:00 PM.');
    expect(texts(renderer)).toContain('Added to the calendar:\nCheckup, Tuesday at 2:00 PM.');
  });

  it('shows a mailbox post as a short notice from Sunny', async () => {
    const mailbox = {
      type: 'post',
      id: 'p3',
      householdId: HOUSEHOLD,
      kind: 'mailbox',
      body: 'Sunny now reads mom@example.com.',
      localDate: '2026-11-13',
      createdAt: 6,
    };
    const renderer = await renderChat(true, [mailbox]);
    expect(texts(renderer)).toContain('Sunny now reads mom@example.com.');
    expect(renderer.root.findAllByType(AgentMessage)).toHaveLength(0);
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
    expect(labels).toContain(
      `On the display: 8:00 Morning pills. Sunny says: ${SENTENCE} Also at 8:00 PM.`,
    );
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

  it('a task with more than one time shows its other times under the card', async () => {
    const renderer = await renderChat(true, WORDING_THREAD);
    const shown = texts(renderer);
    expect(shown).toContain('Also at 8:00 PM');
    expect(shown.indexOf('Also at 8:00 PM')).toBeGreaterThan(shown.indexOf(SENTENCE));
  });

  it('a failed play shows the failure, adds it to the card label and announces it once', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const renderer = await renderChat(true, WORDING_THREAD);
    await act(async () => {
      cardButtons(renderer)[0]!.props.onPress();
    });
    await act(async () => {
      mockSpoken[0]!.options.onError?.(new Error('no voice'));
    });
    expect(texts(renderer)).toContain(PLAY_FAILED_TEXT);
    const card = renderer.root.findAll(
      (node) =>
        node.props.accessible === true &&
        typeof node.props.accessibilityLabel === 'string' &&
        (node.props.accessibilityLabel as string).startsWith('On the display: 8:00'),
    )[0];
    expect(card?.props.accessibilityLabel).toContain(PLAY_FAILED_TEXT);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(PLAY_FAILED_TEXT);
    expect(cardButtons(renderer)[0]!.props.accessibilityLabel).toBe(PLAY_LABEL);
  });

  it('a viewer, who gets posts only, sees no cards', async () => {
    const posts = THREAD.filter((item) => item.type === 'post');
    const renderer = await renderChat(false, posts);
    expect(renderer.root.findAllByType(WordingCard)).toHaveLength(0);
  });
});
