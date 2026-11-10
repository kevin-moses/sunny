// sunny_app/src/display/__tests__/useDisplayVoice.test.tsx
//
// Purpose: Tests for the display's voice layer, rendering the real useDisplayVoice with
// react-test-renderer and fake timers. The boundary is mocked: the voice session comes from
// VoiceContext and ConversationContext values the test controls (what VoiceProvider would
// provide from LiveKit), the tuning values from TuningContext, and expo-audio's microphone
// permission. Covers what Talk does in each state (start; cancel while connecting; stop
// during a session; refused when offline or the microphone is off), the start timeout, the
// voice card through listening, thinking and speaking (ignoring the previous session's
// lines), an agent that speaks first (an opening, not an answer: no follow-up window, no
// lingering), the idle end before a question, after an answer and never while the senior
// speaks or before the agent joins, injected tuning values, the answer lingering after the
// session (also when the transcript is cleared) and leaving when dismissed, the sample answer
// from the developer sheet, the failure lines and the standing status line.
//
// Last modified: 2026-11-09

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

/** The session and surroundings as the test sets them. */
interface Session {
  connection: VoiceConnectionState;
  agent: AgentState;
  messages: ConversationMessage[];
  /** Defaults to true while connected or reconnecting. */
  agentJoined?: boolean;
  userSpeaking?: boolean;
  error?: string | null;
  offline?: boolean;
  tuning?: Partial<DisplayTuning>;
  sample?: SampleAnswer | null;
}

const OFF: Session = { connection: 'disconnected', agent: 'disconnected', messages: [] };
const LISTENING: Session = { connection: 'connected', agent: 'listening', messages: [] };
const T = DEFAULT_TUNING;

/**
 * purpose: A transcript line.
 * @param id: (string) Its id.
 * @param type: ('userTranscript' | 'agentTranscript') Who said it.
 * @param message: (string) The words.
 * @return: (ConversationMessage) The line.
 */
function line(
  id: string,
  type: 'userTranscript' | 'agentTranscript',
  message: string,
): ConversationMessage {
  return { id, type, message, timestamp: 0 } as ConversationMessage;
}

/** A question and its answer. */
const QA = [line('q', 'userTranscript', 'When?'), line('a', 'agentTranscript', 'At 2.')];

/**
 * purpose: Render the real hook inside the voice and tuning contexts.
 * @param first: (Session) The first state.
 * @return: (Promise<{ get, set }>) The hook's latest result and a function to change the state.
 */
async function renderVoice(first: Session): Promise<{
  get: () => DisplayVoice;
  set: (next: Session) => Promise<void>;
}> {
  let current!: DisplayVoice;
  const Probe = ({ offline }: { offline: boolean }): null => {
    current = useDisplayVoice('10:42', offline, show);
    return null;
  };
  /**
   * purpose: The tree for a state.
   * @param s: (Session) The state.
   * @return: (JSX.Element) The providers around the probe.
   */
  const tree = (s: Session) => {
    const voice: VoiceApi = {
      isInteractive: s.connection !== 'disconnected',
      connectionState: s.connection,
      error: s.error ?? null,
      clearError: () => undefined,
      connect,
      disconnect,
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

/**
 * purpose: Advance fake time inside act.
 * @param ms: (number) Milliseconds.
 * @return: (Promise<void>) Resolves after the timers ran.
 */
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
    // The microphone opened (pre-connect buffer) but the agent never comes.
    await h.set({ connection: 'connecting', agent: 'pre-connect-buffering', messages: [] });
    await advance(T.startTimeoutMs - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(CONNECT_FAILED_MESSAGE);
  });

  it('does not run once the agent has joined', async () => {
    await renderVoice({ ...LISTENING, userSpeaking: true });
    await advance(10 * T.startTimeoutMs);
    expect(disconnect).not.toHaveBeenCalled();
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

  it('never ends while the senior is speaking', async () => {
    await renderVoice({ ...LISTENING, userSpeaking: true });
    await advance(10 * T.firstQuestionMs);
    expect(disconnect).not.toHaveBeenCalled();
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
