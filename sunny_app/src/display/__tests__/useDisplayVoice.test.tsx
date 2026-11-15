import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AgentState } from '@livekit/components-react';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ConversationContext, VoiceContext } from '../../voice/voiceContext';
import type {
  ConversationApi,
  ConversationMessage,
  VoiceApi,
  VoiceConnectionState,
} from '../../voice/voiceContext';
import { DEFAULT_TUNING } from '../tuning';
import type { DisplayTuning } from '../tuning';
import { TuningContext } from '../TuningProvider';
import type { SampleAnswer, TuningControls } from '../TuningProvider';
import {
  CEILING_MESSAGE,
  MIC_OFF_MESSAGE,
  OFFLINE_MESSAGE,
  STOPPED_MESSAGE,
  useDisplayVoice,
} from '../useDisplayVoice';
import type { DisplayVoice } from '../useDisplayVoice';
import { CONNECT_FAILED_MESSAGE } from '../voiceModel';

const mockPermission = jest.fn(async () => ({ granted: true }));

jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: () => mockPermission(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('../../logging/logger', () => ({
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const connect = jest.fn(async () => undefined);
const disconnect = jest.fn(async () => undefined);
const show = jest.fn((_text: string) => undefined);

interface Session {
  connection: VoiceConnectionState;
  agent: AgentState;
  messages: ConversationMessage[];
  agentJoined?: boolean;
  userSpeaking?: boolean;
  error?: string | null;
  offline?: boolean;
  tuning?: Partial<DisplayTuning>;
  sample?: SampleAnswer | null;
  disconnectFn?: () => Promise<void>;
}

const OFF: Session = { connection: 'disconnected', agent: 'disconnected', messages: [] };
const LISTENING: Session = { connection: 'connected', agent: 'listening', messages: [] };
const T = DEFAULT_TUNING;

function line(
  id: string,
  type: 'userTranscript' | 'agentTranscript',
  message: string,
): ConversationMessage {
  return { id, type, message, timestamp: 0 } as ConversationMessage;
}

const QA = [line('q', 'userTranscript', 'When?'), line('a', 'agentTranscript', 'At 2.')];

async function renderVoice(first: Session): Promise<{
  get: () => DisplayVoice;
  set: (next: Session) => Promise<void>;
}> {
  let current!: DisplayVoice;
  const Probe = ({ offline }: { offline: boolean }): null => {
    current = useDisplayVoice('10:42', offline, show);
    return null;
  };
  const tree = (s: Session) => {
    const voice: VoiceApi = {
      isInteractive: s.connection !== 'disconnected',
      connectionState: s.connection,
      error: s.error ?? null,
      clearError: () => undefined,
      connect,
      disconnect: s.disconnectFn ?? disconnect,
    };
    const live = s.connection === 'connected' || s.connection === 'reconnecting';
    const conversation = {
      agentState: s.agent,
      agentJoined: s.agentJoined ?? live,
      messages: s.messages,
      userSpeaking: s.userSpeaking ?? false,
    } as ConversationApi;
    const tuning = {
      tuning: { ...DEFAULT_TUNING, ...s.tuning },
      sample: s.sample ?? null,
    } as TuningControls;
    return (
      <TuningContext.Provider value={tuning}>
        <VoiceContext.Provider value={voice}>
          <ConversationContext.Provider value={conversation}>
            <Probe offline={s.offline ?? false} />
          </ConversationContext.Provider>
        </VoiceContext.Provider>
      </TuningContext.Provider>
    );
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(first));
  });
  return {
    get: () => current,
    set: async (next: Session) => {
      await act(async () => {
        renderer.update(tree(next));
      });
    },
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockPermission.mockResolvedValue({ granted: true });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Talk', () => {
  it('starts a session when none is live', async () => {
    const h = await renderVoice(OFF);
    expect(h.get().card).toBeNull();
    act(() => h.get().talk());
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('cancels a session that is still connecting', async () => {
    const h = await renderVoice({ ...OFF, connection: 'connecting' });
    expect(h.get().card).toMatchObject({ title: 'One moment' });
    act(() => h.get().talk());
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(STOPPED_MESSAGE);
    expect(connect).not.toHaveBeenCalled();
  });

  it('ends a live session and says so', async () => {
    const h = await renderVoice(LISTENING);
    act(() => h.get().talk());
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(STOPPED_MESSAGE);
    expect(connect).not.toHaveBeenCalled();
  });

  it('explains a refused microphone instead of connecting', async () => {
    mockPermission.mockResolvedValue({ granted: false });
    const h = await renderVoice(OFF);
    act(() => h.get().talk());
    expect(show).toHaveBeenCalledWith(MIC_OFF_MESSAGE);
    expect(connect).not.toHaveBeenCalled();
  });

  it('says it is not connected instead of connecting while offline', async () => {
    const h = await renderVoice({ ...OFF, offline: true });
    act(() => h.get().talk());
    expect(show).toHaveBeenCalledWith(OFFLINE_MESSAGE);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('start timeout', () => {
  it('gives up when the agent has not joined within startTimeoutMs', async () => {
    const h = await renderVoice({ ...OFF, connection: 'connecting' });
    await h.set({ connection: 'connecting', agent: 'pre-connect-buffering', messages: [] });
    await advance(T.startTimeoutMs - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(CONNECT_FAILED_MESSAGE);
  });

  it('does not run once the agent has joined', async () => {
    await renderVoice({ ...LISTENING, userSpeaking: true });
    await advance(T.startTimeoutMs + 1000);
    expect(disconnect).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalledWith(CONNECT_FAILED_MESSAGE);
  });

  it('counts from the press however the session state and callbacks churn', async () => {
    const h = await renderVoice({ ...OFF, connection: 'connecting' });
    const states: Session[] = [
      { ...OFF, connection: 'connecting', agent: 'connecting' },
      { ...OFF, connection: 'connecting', agent: 'pre-connect-buffering' },
      { ...OFF, connection: 'connected', agent: 'pre-connect-buffering', agentJoined: false },
      { ...OFF, connection: 'connected', agent: 'initializing', agentJoined: false },
    ];
    for (const state of states) {
      await advance(3_000);
      await h.set({ ...state, disconnectFn: () => disconnect() });
    }
    await advance(T.startTimeoutMs - 12_000 - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(CONNECT_FAILED_MESSAGE);
  });

  it('does not apply once the agent has joined, even if the agent then leaves', async () => {
    const h = await renderVoice({ ...LISTENING, messages: QA });
    await h.set({ ...LISTENING, messages: QA, agentJoined: false });
    await h.set({ ...LISTENING, messages: QA, agentJoined: false, error: 'Agent left' });
    await advance(T.startTimeoutMs + 1000);
    expect(show).not.toHaveBeenCalledWith(CONNECT_FAILED_MESSAGE);
    expect(show).toHaveBeenCalledWith('Sunny stopped. Press Talk to try again.');
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('honors a tuned value above 20 s', async () => {
    await renderVoice({ ...OFF, connection: 'connecting', tuning: { startTimeoutMs: 30_000 } });
    await advance(29_999);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('follows the tuned value', async () => {
    await renderVoice({ ...OFF, connection: 'connecting', tuning: { startTimeoutMs: 5_000 } });
    await advance(5_000);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('voice card', () => {
  it('follows listening, thinking and speaking, ignoring the last session lines', async () => {
    const old = [line('o1', 'userTranscript', 'Old?'), line('o2', 'agentTranscript', 'Old.')];
    const h = await renderVoice({ ...OFF, messages: old });
    await h.set({ connection: 'connecting', agent: 'pre-connect-buffering', messages: old });
    expect(h.get().card).toMatchObject({ title: 'Listening' });
    expect(h.get().status).toBe('Press Talk to stop');

    const asked = [...old, line('q', 'userTranscript', 'When is Sarah coming?')];
    await h.set({ connection: 'connected', agent: 'thinking', messages: asked });
    expect(h.get().card).toMatchObject({ title: 'Thinking', detail: '"When is Sarah coming?"' });

    const answered = [...asked, line('a', 'agentTranscript', 'Today at 2.')];
    await h.set({ connection: 'connected', agent: 'speaking', messages: answered });
    expect(h.get().card).toEqual({ kind: 'answer', tab: 'Sunny', text: 'Today at 2.' });
  });

  it('keeps the answer for answerLingerMs after the session, even if the transcript clears', async () => {
    const h = await renderVoice({ ...LISTENING, messages: QA });
    await h.set(OFF);
    expect(h.get().card).toEqual({ kind: 'answer', tab: 'Sunny said  ·  10:42', text: 'At 2.' });
    expect(h.get().active).toBe(false);
    await advance(T.answerLingerMs - 1);
    expect(h.get().card).not.toBeNull();
    await advance(1);
    expect(h.get().card).toBeNull();
  });

  it('drops a lingering answer when dismissed or when a new session starts', async () => {
    const h = await renderVoice({ ...LISTENING, messages: QA });
    await h.set({ ...OFF, messages: QA });
    expect(h.get().card).toMatchObject({ kind: 'answer' });
    act(() => h.get().dismissAnswer());
    expect(h.get().card).toBeNull();

    await h.set({ ...LISTENING, messages: QA });
    await h.set({ ...OFF, messages: QA });
    await h.set({ connection: 'connecting', agent: 'connecting', messages: QA });
    expect(h.get().card).toMatchObject({ title: 'One moment' });
  });

  it('shows no answer after a session in which nothing was answered', async () => {
    const h = await renderVoice(LISTENING);
    await h.set(OFF);
    expect(h.get().card).toBeNull();
  });

  it('shows the sample answer the developer sheet asks for', async () => {
    const h = await renderVoice(OFF);
    await h.set({ ...OFF, sample: { text: 'Sample.', id: 1 } });
    expect(h.get().card).toMatchObject({ kind: 'answer', text: 'Sample.' });
  });
});

describe('agent speaking first', () => {
  const greeting = [line('g', 'agentTranscript', 'Hello, Margaret.')];

  it('shows the opening while spoken but treats it as no answer', async () => {
    const h = await renderVoice({ ...LISTENING, agent: 'speaking', messages: greeting });
    expect(h.get().card).toMatchObject({ kind: 'answer', text: 'Hello, Margaret.' });

    await h.set({ ...LISTENING, messages: greeting });
    expect(h.get().card).toMatchObject({ title: 'Listening' });
    await advance(T.followUpMs);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(T.firstQuestionMs - T.followUpMs);
    expect(disconnect).toHaveBeenCalledTimes(1);

    await h.set({ ...OFF, messages: greeting });
    expect(h.get().card).toBeNull();
  });
});

describe('idle end', () => {
  it('ends a session with no question after firstQuestionMs', async () => {
    await renderVoice(LISTENING);
    await advance(T.firstQuestionMs - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(STOPPED_MESSAGE);
  });

  it('ends followUpMs after an answer', async () => {
    await renderVoice({ ...LISTENING, messages: QA });
    await advance(T.followUpMs - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('uses injected tuning values', async () => {
    await renderVoice({ ...LISTENING, messages: QA, tuning: { followUpMs: 4_000 } });
    await advance(4_000);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('restarts the wait when a new question starts arriving', async () => {
    const h = await renderVoice({ ...LISTENING, messages: QA });
    await advance(T.followUpMs - 1000);
    await h.set({ ...LISTENING, messages: [...QA, line('q2', 'userTranscript', 'And')] });
    await advance(T.firstQuestionMs - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('holds the session open while the senior speaks, but only for speakingCapMs', async () => {
    await renderVoice({ ...LISTENING, userSpeaking: true });
    await advance(T.speakingCapMs);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(T.firstQuestionMs - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('session ceiling', () => {
  async function keepBusy(h: { set: (next: Session) => Promise<void> }, ms: number): Promise<void> {
    const lines: ConversationMessage[] = [];
    for (let t = 0; t < ms; t += 5_000) {
      lines.push(line(`tv${t}`, 'userTranscript', `words ${t}`));
      await h.set({ ...LISTENING, userSpeaking: true, messages: [...lines] });
      await advance(5_000);
    }
  }

  it('ends any session sessionMaxMs after it started, however busy', async () => {
    const h = await renderVoice({ ...LISTENING, userSpeaking: true });
    await keepBusy(h, T.sessionMaxMs - 5_000);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(5_000);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(CEILING_MESSAGE);
  });

  const SLOW = { stuckMs: 180_000, sessionMaxMs: 120_000 };

  it('lets an answer being spoken finish before ending', async () => {
    const answering = { ...LISTENING, agent: 'speaking' as const, messages: QA, tuning: SLOW };
    const h = await renderVoice(answering);
    await advance(SLOW.sessionMaxMs);
    expect(disconnect).not.toHaveBeenCalled();
    await h.set({ ...answering, agent: 'listening' });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(CEILING_MESSAGE);
  });

  it('ends after ceilingGraceMs even if the answer keeps going', async () => {
    const answering = { ...LISTENING, agent: 'speaking' as const, messages: QA, tuning: SLOW };
    const h = await renderVoice(answering);
    await advance(SLOW.sessionMaxMs);
    await advance(T.ceilingGraceMs - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await h.set(OFF);
  });

  it('does not wait for an opening line the agent says before any question', async () => {
    const greeting = [line('g', 'agentTranscript', 'Hello.')];
    await renderVoice({ ...LISTENING, agent: 'speaking', messages: greeting, tuning: SLOW });
    await advance(SLOW.sessionMaxMs);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('failures and status', () => {
  it('says it could not connect when the agent never joined', async () => {
    const h = await renderVoice({ ...OFF, connection: 'connecting' });
    await h.set({
      ...OFF,
      connection: 'connected',
      agent: 'pre-connect-buffering',
      agentJoined: false,
    });
    await h.set({ ...OFF, error: 'Agent did not connect' });
    expect(show).toHaveBeenCalledWith(CONNECT_FAILED_MESSAGE);
    expect(show).not.toHaveBeenCalledWith('Sunny stopped. Press Talk to try again.');
  });

  it('says Sunny stopped when the session failed after the agent joined', async () => {
    const h = await renderVoice(LISTENING);
    await h.set({ ...OFF, error: 'Agent left' });
    expect(show).toHaveBeenCalledWith('Sunny stopped. Press Talk to try again.');
  });

  it('shows no voice card once the agent failed', async () => {
    const h = await renderVoice({ ...LISTENING, agent: 'failed' });
    expect(h.get().card).toBeNull();
    expect(h.get().active).toBe(false);
  });

  it('shows Reconnecting while LiveKit reconnects', async () => {
    const h = await renderVoice({ ...LISTENING, connection: 'reconnecting' });
    expect(h.get().status).toBe('Reconnecting');
  });

  it('has no status line without a session', async () => {
    const h = await renderVoice(OFF);
    expect(h.get().status).toBeNull();
    expect(h.get().active).toBe(false);
  });
});
