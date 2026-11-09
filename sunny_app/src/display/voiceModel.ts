// sunny_app/src/display/voiceModel.ts
//
// Purpose: Pure rules for the home display's voice experience (useDisplayVoice wires them to
// LiveKit). They decide:
// - the voice phase from the connection and agent states: off, starting (fetching the token,
//   before the microphone opens), listening (the microphone is open: LiveKit's pre-connect
//   buffer keeps speech said before the agent joins), thinking, speaking;
// - the latest exchange from the transcript: the senior's last question and the agent's
//   answer to it (every agent line after that question, joined);
// - how long the session may stay quiet before it ends by itself (idleTimeoutMs);
// - what the voice card on the panel shows (voiceCard): a tab and either a large title with a
//   detail line, or the answer as large text. A finished session's answer lingers (the hook
//   keeps it for ANSWER_LINGER_MS) so a repeated question can be answered by a glance.
// - the plain-words failure line for a session that failed (failureMessage).
// Nothing here starts timers or touches LiveKit.
//
// Last modified: 2026-11-09

import type { AgentState } from '@livekit/components-react';
import type { SFSymbol } from 'expo-symbols';

import type { VoiceConnectionState } from '../voice/voiceContext';

/** How long (ms) the senior may stay quiet after pressing Talk before the session ends. */
export const FIRST_QUESTION_MS = 20_000;

/** How long (ms) the session waits for a follow-up question after an answer. */
export const FOLLOW_UP_MS = 10_000;

/** How long (ms) the agent may think or speak with nothing changing before the session ends. */
export const STUCK_MS = 60_000;

/** How long (ms) an answer stays on the panel after the session ends. */
export const ANSWER_LINGER_MS = 3 * 60_000;

/** Where the voice session is, as the display shows it. */
export type VoicePhase = 'off' | 'starting' | 'listening' | 'thinking' | 'speaking';

/** The parts of a transcript message the display reads. */
export interface TranscriptLine {
  id: string;
  type?: string;
  message: string;
}

/** The senior's last question and the agent's answer to it, from the transcript. */
export interface Exchange {
  question: string | null;
  answer: string | null;
}

/** An answer kept on the panel for ANSWER_LINGER_MS after its session ended. */
export interface LingeringAnswer {
  text: string;
  /** The clock time it was given ("10:42"), or null when the day has not loaded. */
  at: string | null;
}

/** What the voice card shows: a tab, then a symbol and title with an optional detail line, or an answer. */
export type VoiceCard =
  | { kind: 'prompt'; tab: string; icon: SFSymbol; title: string; detail: string | null }
  | { kind: 'answer'; tab: string; text: string };

/**
 * purpose: The voice phase from the voice connection state and LiveKit's agent state.
 * @param connection: (VoiceConnectionState) The app's connection state.
 * @param agent: (AgentState) LiveKit's agent state.
 * @return: (VoicePhase) The phase; off when no session is live.
 */
export function voicePhase(connection: VoiceConnectionState, agent: AgentState): VoicePhase {
  if (connection === 'disconnected') return 'off';
  switch (agent) {
    case 'pre-connect-buffering':
    case 'initializing':
    case 'idle':
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return 'starting';
  }
}

/**
 * purpose: The latest exchange in a transcript: the senior's last line, and the agent's lines
 *          after it joined with spaces (the answer). Lines in `ignore` (left over from an
 *          earlier session) and blank lines are skipped.
 * @param lines: (TranscriptLine[]) The transcript, oldest first.
 * @param ignore: (ReadonlySet<string>) Ids of lines to skip.
 * @return: (Exchange) The question and answer, each null when there is none.
 */
export function latestExchange(lines: TranscriptLine[], ignore: ReadonlySet<string>): Exchange {
  let question: string | null = null;
  let answer: string[] = [];
  for (const line of lines) {
    const text = line.message.trim();
    if (ignore.has(line.id) || text === '') continue;
    if (line.type === 'userTranscript') {
      question = text;
      answer = [];
    } else if (line.type === 'agentTranscript') {
      answer.push(text);
    }
  }
  return { question, answer: answer.length > 0 ? answer.join(' ') : null };
}

/**
 * purpose: How long the session may go on with nothing changing before it ends by itself.
 * @param phase: (VoicePhase) The phase.
 * @param userSpeaking: (boolean) The senior is speaking.
 * @param answered: (boolean) An answer has been given in this session.
 * @return: (number | null) Milliseconds, or null when the session must not end now (off,
 *          starting, which the provider's own timeout covers, or while the senior speaks).
 */
export function idleTimeoutMs(
  phase: VoicePhase,
  userSpeaking: boolean,
  answered: boolean,
): number | null {
  if (userSpeaking) return null;
  switch (phase) {
    case 'listening':
      return answered ? FOLLOW_UP_MS : FIRST_QUESTION_MS;
    case 'thinking':
    case 'speaking':
      return STUCK_MS;
    default:
      return null;
  }
}

/**
 * purpose: What the voice card shows.
 * @param phase: (VoicePhase) The phase.
 * @param exchange: (Exchange) The session's latest exchange.
 * @param lingering: (LingeringAnswer | null) A finished session's answer still on screen.
 * @return: (VoiceCard | null) The card, or null when there is nothing to show.
 */
export function voiceCard(
  phase: VoicePhase,
  exchange: Exchange,
  lingering: LingeringAnswer | null,
): VoiceCard | null {
  switch (phase) {
    case 'off':
      if (lingering === null) return null;
      return {
        kind: 'answer',
        tab: lingering.at === null ? 'Sunny said' : `Sunny said  ·  ${lingering.at}`,
        text: lingering.text,
      };
    case 'starting':
      return {
        kind: 'prompt',
        tab: 'Talk',
        icon: 'hourglass',
        title: 'One moment',
        detail: 'Getting ready to listen.',
      };
    case 'listening':
      // After an answer the microphone stays open for a follow-up; the answer stays in view.
      return exchange.answer === null
        ? {
            kind: 'prompt',
            tab: 'Talk',
            icon: 'mic',
            title: 'Listening',
            detail: 'Ask your question.',
          }
        : { kind: 'answer', tab: 'Sunny  ·  Listening', text: exchange.answer };
    case 'thinking':
      return {
        kind: 'prompt',
        tab: 'Talk',
        icon: 'ellipsis',
        title: 'Thinking',
        detail: exchange.question === null ? null : `"${exchange.question}"`,
      };
    case 'speaking':
      return exchange.answer === null
        ? { kind: 'prompt', tab: 'Sunny', icon: 'speaker.wave.2', title: 'Answering', detail: null }
        : { kind: 'answer', tab: 'Sunny', text: exchange.answer };
  }
}

/**
 * purpose: The plain-words line for a voice session that failed.
 * @param reachedListening: (boolean) The failed session had opened the microphone.
 * @return: (string) The line for the status area.
 */
export function failureMessage(reachedListening: boolean): string {
  return reachedListening
    ? 'Sunny stopped. Press Talk to try again.'
    : 'Could not connect. Try again.';
}
