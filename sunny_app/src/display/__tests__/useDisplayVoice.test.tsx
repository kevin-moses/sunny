// sunny_app/src/display/__tests__/useDisplayVoice.test.tsx
//
// Purpose: Tests for the display's voice layer, rendering the real useDisplayVoice with
// react-test-renderer and fake timers. The boundary is mocked: the voice session comes from
// VoiceContext and ConversationContext values the test controls (what VoiceProvider would
// provide from LiveKit), and expo-audio's microphone permission. Covers what Talk does in each
// state (start, ignored while starting, stop during a session, refused microphone), the voice
// card through listening, thinking and speaking (ignoring the previous session's lines), the
// idle end before a question, after an answer and never while the senior speaks, the answer
// lingering after the session (also when the transcript is cleared) and leaving after
// ANSWER_LINGER_MS or when dismissed, the failure lines and the standing status line.
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
import { MIC_OFF_MESSAGE, STOPPED_MESSAGE, useDisplayVoice } from '../useDisplayVoice';
import type { DisplayVoice } from '../useDisplayVoice';
import { ANSWER_LINGER_MS, FIRST_QUESTION_MS, FOLLOW_UP_MS } from '../voiceModel';

const mockPermission = jest.fn(async () => ({ granted: true }));

jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: () => mockPermission(),
}));

jest.mock('../../logging/logger', () => ({
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const connect = jest.fn(async () => undefined);
const disconnect = jest.fn(async () => undefined);
const show = jest.fn((_text: string) => undefined);

/** The session as the test sets it. */
interface Session {
  connection: VoiceConnectionState;
  agent: AgentState;
  messages: ConversationMessage[];
  userSpeaking?: boolean;
  error?: string | null;
}

const OFF: Session = { connection: 'disconnected', agent: 'disconnected', messages: [] };

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

/**
 * purpose: Render the real hook inside the voice contexts.
 * @param first: (Session) The first session state.
 * @return: (Promise<{ get, set }>) The hook's latest result and a function to change the session.
 */
async function renderVoice(first: Session): Promise<{
  get: () => DisplayVoice;
  set: (next: Session) => Promise<void>;
}> {
  let current!: DisplayVoice;
  const Probe = (): null => {
    current = useDisplayVoice('10:42', show);
    return null;
  };
  /**
   * purpose: The tree for a session state.
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
    const conversation = {
      agentState: s.agent,
      messages: s.messages,
      userSpeaking: s.userSpeaking ?? false,
    } as ConversationApi;
    return (
      <VoiceContext.Provider value={voice}>
        <ConversationContext.Provider value={conversation}>
          <Probe />
        </ConversationContext.Provider>
      </VoiceContext.Provider>
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

  it('is ignored while the session is starting, and the key shows busy', async () => {
    const h = await renderVoice({ ...OFF, connection: 'connecting' });
    expect(h.get().busy).toBe(true);
    expect(h.get().card).toMatchObject({ title: 'One moment' });
    act(() => h.get().talk());
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('ends a live session and says so', async () => {
    const h = await renderVoice({ ...OFF, connection: 'connected', agent: 'listening' });
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

  it('keeps the answer for a few minutes after the session, even if the transcript clears', async () => {
    const msgs = [line('q', 'userTranscript', 'When?'), line('a', 'agentTranscript', 'At 2.')];
    const h = await renderVoice({ connection: 'connected', agent: 'listening', messages: msgs });
    await h.set(OFF);
    expect(h.get().card).toEqual({ kind: 'answer', tab: 'Sunny said  ·  10:42', text: 'At 2.' });
    expect(h.get().active).toBe(false);
    await advance(ANSWER_LINGER_MS - 1);
    expect(h.get().card).not.toBeNull();
    await advance(1);
    expect(h.get().card).toBeNull();
  });

  it('drops a lingering answer when dismissed or when a new session starts', async () => {
    const msgs = [line('q', 'userTranscript', 'When?'), line('a', 'agentTranscript', 'At 2.')];
    const h = await renderVoice({ connection: 'connected', agent: 'listening', messages: msgs });
    await h.set({ ...OFF, messages: msgs });
    expect(h.get().card).toMatchObject({ kind: 'answer' });
    act(() => h.get().dismissAnswer());
    expect(h.get().card).toBeNull();

    await h.set({ connection: 'connected', agent: 'listening', messages: msgs });
    await h.set({ ...OFF, messages: msgs });
    await h.set({ connection: 'connecting', agent: 'connecting', messages: msgs });
    expect(h.get().card).toMatchObject({ title: 'One moment' });
  });

  it('shows no answer after a session in which nothing was answered', async () => {
    const h = await renderVoice({ connection: 'connected', agent: 'listening', messages: [] });
    await h.set(OFF);
    expect(h.get().card).toBeNull();
  });
});

describe('idle end', () => {
  it('ends a session with no question after FIRST_QUESTION_MS', async () => {
    await renderVoice({ connection: 'connected', agent: 'listening', messages: [] });
    await advance(FIRST_QUESTION_MS - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(STOPPED_MESSAGE);
  });

  it('ends FOLLOW_UP_MS after an answer', async () => {
    const msgs = [line('q', 'userTranscript', 'When?'), line('a', 'agentTranscript', 'At 2.')];
    await renderVoice({ connection: 'connected', agent: 'listening', messages: msgs });
    await advance(FOLLOW_UP_MS - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('restarts the wait when a new question starts arriving', async () => {
    const msgs = [line('q', 'userTranscript', 'When?'), line('a', 'agentTranscript', 'At 2.')];
    const h = await renderVoice({ connection: 'connected', agent: 'listening', messages: msgs });
    await advance(FOLLOW_UP_MS - 1000);
    await h.set({
      connection: 'connected',
      agent: 'listening',
      messages: [...msgs, line('q2', 'userTranscript', 'And')],
    });
    await advance(FIRST_QUESTION_MS - 1);
    expect(disconnect).not.toHaveBeenCalled();
    await advance(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('never ends while the senior is speaking', async () => {
    await renderVoice({
      connection: 'connected',
      agent: 'listening',
      messages: [],
      userSpeaking: true,
    });
    await advance(10 * FIRST_QUESTION_MS);
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe('failures and status', () => {
  it('says it could not connect when the session failed before listening', async () => {
    const h = await renderVoice(OFF);
    await h.set({ ...OFF, connection: 'connecting' });
    await h.set({ ...OFF, error: 'token failed' });
    expect(show).toHaveBeenCalledWith('Could not connect. Try again.');
  });

  it('says Sunny stopped when the session failed after listening', async () => {
    const h = await renderVoice({ connection: 'connected', agent: 'listening', messages: [] });
    await h.set({ ...OFF, error: 'Agent left' });
    expect(show).toHaveBeenCalledWith('Sunny stopped. Press Talk to try again.');
  });

  it('shows Reconnecting while LiveKit reconnects', async () => {
    const h = await renderVoice({ connection: 'reconnecting', agent: 'listening', messages: [] });
    expect(h.get().status).toBe('Reconnecting');
  });

  it('has no status line without a session', async () => {
    const h = await renderVoice(OFF);
    expect(h.get().status).toBeNull();
    expect(h.get().active).toBe(false);
  });
});
