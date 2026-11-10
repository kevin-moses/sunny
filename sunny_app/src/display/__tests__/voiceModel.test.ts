// sunny_app/src/display/__tests__/voiceModel.test.ts
//
// Purpose: Unit tests for the display's voice rules (voiceModel.ts): the phase from LiveKit's
// states (a failed agent is off, not "One moment"), the latest question and answer from the
// transcript (old lines ignored; the agent speaking first is an opening, never an answer),
// the idle timeouts (none before the agent joins), what the voice card shows in each phase
// and after the session, and the failure wording.
//
// Last modified: 2026-11-09

import { describe, expect, it } from '@jest/globals';

import { DEFAULT_TUNING } from '../tuning';
import {
  CONNECT_FAILED_MESSAGE,
  failureMessage,
  idleTimeoutMs,
  latestExchange,
  voiceCard,
  voicePhase,
} from '../voiceModel';
import type { IdleInput, TranscriptLine } from '../voiceModel';

const NONE = { question: null, answer: null, opening: null };

describe('voicePhase', () => {
  it('is off without a session, whatever the agent state', () => {
    expect(voicePhase('disconnected', 'speaking')).toBe('off');
  });

  it('is starting while the token is fetched and until the microphone opens', () => {
    expect(voicePhase('connecting', 'disconnected')).toBe('starting');
    expect(voicePhase('connecting', 'connecting')).toBe('starting');
  });

  it('is off once the agent failed, not starting', () => {
    expect(voicePhase('connected', 'failed')).toBe('off');
    expect(voicePhase('connected', 'disconnected')).toBe('off');
  });

  it('is listening once the pre-connect buffer records, and while the agent listens', () => {
    for (const agent of ['pre-connect-buffering', 'initializing', 'idle', 'listening'] as const) {
      expect(voicePhase('connected', agent)).toBe('listening');
    }
  });

  it('follows thinking and speaking, also while reconnecting', () => {
    expect(voicePhase('connected', 'thinking')).toBe('thinking');
    expect(voicePhase('reconnecting', 'speaking')).toBe('speaking');
  });
});

describe('latestExchange', () => {
  const lines: TranscriptLine[] = [
    { id: '1', type: 'userTranscript', message: 'When is Sarah coming?' },
    { id: '2', type: 'agentTranscript', message: 'Sarah is coming today at 2.' },
    { id: '3', type: 'userTranscript', message: 'And Tom?' },
    { id: '4', type: 'agentTranscript', message: 'Let me check.' },
    { id: '5', type: 'agentTranscript', message: 'Tom comes on Friday.' },
  ];

  it('joins the agent lines after the last question', () => {
    expect(latestExchange(lines, new Set())).toEqual({
      question: 'And Tom?',
      answer: 'Let me check. Tom comes on Friday.',
      opening: null,
    });
  });

  it('has no answer while the last question is unanswered', () => {
    expect(latestExchange(lines.slice(0, 3), new Set())).toEqual({
      question: 'And Tom?',
      answer: null,
      opening: null,
    });
  });

  it('treats agent lines before any question as the opening, not an answer', () => {
    const greeting: TranscriptLine[] = [
      { id: 'g', type: 'agentTranscript', message: 'Hello, Margaret.' },
    ];
    expect(latestExchange(greeting, new Set())).toEqual({
      question: null,
      answer: null,
      opening: 'Hello, Margaret.',
    });
  });

  it('skips ignored, blank and chat lines', () => {
    const extra: TranscriptLine[] = [
      ...lines.slice(0, 2),
      { id: '6', type: 'agentTranscript', message: '   ' },
      { id: '7', type: 'chatMessage', message: 'typed' },
    ];
    expect(latestExchange(extra, new Set(['1', '2']))).toEqual(NONE);
  });
});

describe('idleTimeoutMs', () => {
  const base: IdleInput = {
    phase: 'listening',
    agentJoined: true,
    userSpeaking: false,
    answered: false,
  };

  it('waits longer for the first question than for a follow-up', () => {
    expect(idleTimeoutMs(base, DEFAULT_TUNING)).toBe(DEFAULT_TUNING.firstQuestionMs);
    expect(idleTimeoutMs({ ...base, answered: true }, DEFAULT_TUNING)).toBe(
      DEFAULT_TUNING.followUpMs,
    );
  });

  it('uses the tuned values', () => {
    const tuning = { firstQuestionMs: 7_000, followUpMs: 4_000, stuckMs: 30_000 };
    expect(idleTimeoutMs(base, tuning)).toBe(7_000);
    expect(idleTimeoutMs({ ...base, phase: 'thinking' }, tuning)).toBe(30_000);
  });

  it('never ends while the senior is speaking', () => {
    expect(idleTimeoutMs({ ...base, userSpeaking: true }, DEFAULT_TUNING)).toBeNull();
  });

  it('has no idle end before the agent joins (the start timeout covers it)', () => {
    expect(idleTimeoutMs({ ...base, agentJoined: false }, DEFAULT_TUNING)).toBeNull();
  });

  it('allows a long stretch while the agent thinks or speaks', () => {
    expect(idleTimeoutMs({ ...base, phase: 'thinking' }, DEFAULT_TUNING)).toBe(
      DEFAULT_TUNING.stuckMs,
    );
    expect(idleTimeoutMs({ ...base, phase: 'speaking' }, DEFAULT_TUNING)).toBe(
      DEFAULT_TUNING.stuckMs,
    );
  });

  it('has no idle end without a session or before the microphone opens', () => {
    expect(idleTimeoutMs({ ...base, phase: 'starting' }, DEFAULT_TUNING)).toBeNull();
    expect(idleTimeoutMs({ ...base, phase: 'off' }, DEFAULT_TUNING)).toBeNull();
  });
});

describe('voiceCard', () => {
  it('shows nothing without a session or a lingering answer', () => {
    expect(voiceCard('off', NONE, null)).toBeNull();
  });

  it('shows a lingering answer with the time it was given', () => {
    expect(voiceCard('off', NONE, { text: 'At 2.', at: '10:42' })).toEqual({
      kind: 'answer',
      tab: 'Sunny said  ·  10:42',
      text: 'At 2.',
    });
    expect(voiceCard('off', NONE, { text: 'At 2.', at: null })).toMatchObject({
      tab: 'Sunny said',
    });
  });

  it('says One moment while starting', () => {
    expect(voiceCard('starting', NONE, null)).toMatchObject({
      kind: 'prompt',
      title: 'One moment',
    });
  });

  it('says Listening before the first question, also after an opening line', () => {
    const listening = { kind: 'prompt', title: 'Listening', detail: 'Ask your question.' };
    expect(voiceCard('listening', NONE, null)).toMatchObject({ ...listening, icon: 'mic' });
    expect(voiceCard('listening', { ...NONE, opening: 'Hello.' }, null)).toMatchObject(listening);
  });

  it('keeps the answer in view while listening for a follow-up', () => {
    expect(voiceCard('listening', { question: 'q', answer: 'At 2.', opening: null }, null)).toEqual(
      {
        kind: 'answer',
        tab: 'Sunny  ·  Listening',
        text: 'At 2.',
      },
    );
  });

  it('shows the question heard while thinking', () => {
    expect(
      voiceCard('thinking', { question: 'When?', answer: null, opening: null }, null),
    ).toMatchObject({ title: 'Thinking', detail: '"When?"' });
    expect(voiceCard('thinking', NONE, null)).toMatchObject({ detail: null });
  });

  it('shows the answer, or an opening line, as it is spoken', () => {
    expect(voiceCard('speaking', { question: 'q', answer: 'Sarah', opening: null }, null)).toEqual({
      kind: 'answer',
      tab: 'Sunny',
      text: 'Sarah',
    });
    expect(voiceCard('speaking', { ...NONE, opening: 'Hello.' }, null)).toMatchObject({
      text: 'Hello.',
    });
    expect(voiceCard('speaking', NONE, null)).toMatchObject({ title: 'Answering' });
  });

  it('ignores a lingering answer while a session is live', () => {
    expect(voiceCard('starting', NONE, { text: 'Old.', at: '9:00' })).toMatchObject({
      kind: 'prompt',
    });
  });
});

describe('failureMessage', () => {
  it('says what to do in plain words, by whether the agent joined', () => {
    expect(failureMessage(false)).toBe(CONNECT_FAILED_MESSAGE);
    expect(failureMessage(true)).toBe('Sunny stopped. Press Talk to try again.');
  });
});
