// sunny_app/src/display/__tests__/voiceModel.test.ts
//
// Purpose: Unit tests for the display's voice rules (voiceModel.ts): the phase from LiveKit's
// states, the latest question and answer from the transcript (old lines ignored), the idle
// timeouts, what the voice card shows in each phase and after the session, and the failure
// wording.
//
// Last modified: 2026-11-09

import { describe, expect, it } from '@jest/globals';

import {
  FIRST_QUESTION_MS,
  FOLLOW_UP_MS,
  STUCK_MS,
  failureMessage,
  idleTimeoutMs,
  latestExchange,
  voiceCard,
  voicePhase,
} from '../voiceModel';
import type { TranscriptLine } from '../voiceModel';

const NONE = { question: null, answer: null };

describe('voicePhase', () => {
  it('is off without a session, whatever the agent state', () => {
    expect(voicePhase('disconnected', 'speaking')).toBe('off');
  });

  it('is starting until the microphone opens', () => {
    expect(voicePhase('connecting', 'disconnected')).toBe('starting');
    expect(voicePhase('connecting', 'connecting')).toBe('starting');
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
    });
  });

  it('has no answer while the last question is unanswered', () => {
    expect(latestExchange(lines.slice(0, 3), new Set())).toEqual({
      question: 'And Tom?',
      answer: null,
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
  it('waits longer for the first question than for a follow-up', () => {
    expect(idleTimeoutMs('listening', false, false)).toBe(FIRST_QUESTION_MS);
    expect(idleTimeoutMs('listening', false, true)).toBe(FOLLOW_UP_MS);
  });

  it('never ends while the senior is speaking', () => {
    expect(idleTimeoutMs('listening', true, true)).toBeNull();
  });

  it('allows a long stretch while the agent thinks or speaks', () => {
    expect(idleTimeoutMs('thinking', false, false)).toBe(STUCK_MS);
    expect(idleTimeoutMs('speaking', false, true)).toBe(STUCK_MS);
  });

  it('has no idle end before the microphone opens or without a session', () => {
    expect(idleTimeoutMs('starting', false, false)).toBeNull();
    expect(idleTimeoutMs('off', false, false)).toBeNull();
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

  it('says Listening before the first question', () => {
    expect(voiceCard('listening', NONE, null)).toMatchObject({
      kind: 'prompt',
      title: 'Listening',
      detail: 'Ask your question.',
      icon: 'mic',
    });
  });

  it('keeps the answer in view while listening for a follow-up', () => {
    expect(voiceCard('listening', { question: 'q', answer: 'At 2.' }, null)).toEqual({
      kind: 'answer',
      tab: 'Sunny  ·  Listening',
      text: 'At 2.',
    });
  });

  it('shows the question heard while thinking', () => {
    expect(voiceCard('thinking', { question: 'When?', answer: null }, null)).toMatchObject({
      title: 'Thinking',
      detail: '"When?"',
    });
    expect(voiceCard('thinking', NONE, null)).toMatchObject({ detail: null });
  });

  it('shows the answer as it is spoken', () => {
    expect(voiceCard('speaking', { question: 'q', answer: 'Sarah' }, null)).toEqual({
      kind: 'answer',
      tab: 'Sunny',
      text: 'Sarah',
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
  it('says what to do in plain words', () => {
    expect(failureMessage(false)).toBe('Could not connect. Try again.');
    expect(failureMessage(true)).toBe('Sunny stopped. Press Talk to try again.');
  });
});
