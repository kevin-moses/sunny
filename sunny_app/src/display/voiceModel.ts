// sunny_app/src/display/voiceModel.ts
//
// Purpose: Pure rules for the home display's voice experience (useDisplayVoice wires them to
// LiveKit). They decide:
// - the voice phase from the connection and agent states: off (also when the agent failed),
//   starting (fetching the token, before the microphone opens), listening (the microphone is
//   open: LiveKit's pre-connect buffer keeps speech said before the agent joins), thinking,
//   speaking;
// - the latest exchange from the transcript: the senior's last question and the agent's
//   answer to it (every agent line after that question, joined). Agent lines before the
//   senior has said anything (a greeting, or a tapped notification's task prompt) are the
//   opening: shown while spoken, but never an answer, so they neither shorten the wait for
//   the first question nor linger on the panel;
// - how long the session may stay quiet before it ends by itself (idleTimeoutMs, from the
//   tuning values; no idle end before the agent has joined, which the start timeout covers);
// - what the voice card on the panel shows (voiceCard): a tab and either a large title with a
//   detail line, or the answer as large text. A finished session's answer lingers (the hook
//   keeps it for the tuned answerLingerMs) so a repeated question can be answered by a glance.
// - the plain-words failure line for a session that failed (failureMessage).
// Nothing here starts timers or touches LiveKit.
//
// Last modified: 2026-11-09

import type { AgentState } from '@livekit/components-react';
import type { SFSymbol } from 'expo-symbols';

import type { VoiceConnectionState } from '../voice/voiceContext';
import { TAB_SEPARATOR } from './theme';
import type { DisplayTuning } from './tuning';

/** The plain-words line when a session never reached the agent. */
export const CONNECT_FAILED_MESSAGE = 'Could not connect. Try again.';

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
  /** What the agent said before the senior said anything, or null. Never an answer. */
  opening: string | null;
}

/** An answer kept on the panel for a while after its session ended. */
export interface LingeringAnswer {
  text: string;
  /** The clock time it was given ("10:42"), or null when the day has not loaded. */
  at: string | null;
}

/** What the voice card shows: a tab, then a symbol and title with a detail line, or an answer. */
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
    case 'failed':
      return 'off';
    case 'disconnected':
      // Only while the token is being fetched (the room is not connected yet).
      return connection === 'connecting' ? 'starting' : 'off';
    case 'connecting':
      return 'starting';
    case 'pre-connect-buffering':
    case 'initializing':
    case 'idle':
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
  }
}

/**
 * purpose: The latest exchange in a transcript: the senior's last line, and the agent's lines
 *          after it joined with spaces (the answer); agent lines before any senior line are
 *          the opening. Lines in `ignore` (left over from an earlier session) and blank lines
 *          are skipped.
 * @param lines: (TranscriptLine[]) The transcript, oldest first.
 * @param ignore: (ReadonlySet<string>) Ids of lines to skip.
 * @return: (Exchange) The question, answer and opening, each null when there is none.
 */
export function latestExchange(lines: TranscriptLine[], ignore: ReadonlySet<string>): Exchange {
  let question: string | null = null;
  let agent: string[] = [];
  for (const line of lines) {
    const text = line.message.trim();
    if (ignore.has(line.id) || text === '') continue;
    if (line.type === 'userTranscript') {
      question = text;
      agent = [];
    } else if (line.type === 'agentTranscript') {
      agent.push(text);
    }
  }
  const said = agent.length > 0 ? agent.join(' ') : null;
  return question === null
    ? { question, answer: null, opening: said }
    : { question, answer: said, opening: null };
}

/** What decides the idle end of a session. */
export interface IdleInput {
  phase: VoicePhase;
  /** The agent participant is in the room. */
  agentJoined: boolean;
  /** The senior is speaking. */
  userSpeaking: boolean;
  /** An answer to a question has been given in this session. */
  answered: boolean;
}

/**
 * purpose: How long the session may go on with nothing changing before it ends by itself.
 * @param input: (IdleInput) The phase, whether the agent joined, whether the senior speaks,
 *        and whether a question was answered.
 * @param tuning: (Pick<DisplayTuning, 'firstQuestionMs' | 'followUpMs' | 'stuckMs'>) The
 *        tuned waits.
 * @return: (number | null) Milliseconds, or null when the session must not end now (no
 *          session, the agent not joined yet, which the start timeout covers, or while the
 *          senior speaks).
 */
export function idleTimeoutMs(
  input: IdleInput,
  tuning: Pick<DisplayTuning, 'firstQuestionMs' | 'followUpMs' | 'stuckMs'>,
): number | null {
  if (input.userSpeaking || !input.agentJoined) return null;
  switch (input.phase) {
    case 'listening':
      return input.answered ? tuning.followUpMs : tuning.firstQuestionMs;
    case 'thinking':
    case 'speaking':
      return tuning.stuckMs;
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
        tab: lingering.at === null ? 'Sunny said' : `Sunny said${TAB_SEPARATOR}${lingering.at}`,
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
        : { kind: 'answer', tab: `Sunny${TAB_SEPARATOR}Listening`, text: exchange.answer };
    case 'thinking':
      return {
        kind: 'prompt',
        tab: 'Talk',
        icon: 'ellipsis',
        title: 'Thinking',
        detail: exchange.question === null ? null : `"${exchange.question}"`,
      };
    case 'speaking': {
      const said = exchange.answer ?? exchange.opening;
      return said === null
        ? { kind: 'prompt', tab: 'Sunny', icon: 'speaker.wave.2', title: 'Answering', detail: null }
        : { kind: 'answer', tab: 'Sunny', text: said };
    }
  }
}

/**
 * purpose: The plain-words line for a voice session that failed.
 * @param agentJoined: (boolean) The agent had joined the failed session.
 * @return: (string) The line for the status area.
 */
export function failureMessage(agentJoined: boolean): string {
  return agentJoined ? 'Sunny stopped. Press Talk to try again.' : CONNECT_FAILED_MESSAGE;
}
