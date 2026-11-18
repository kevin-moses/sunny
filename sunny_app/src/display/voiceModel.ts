import type { AgentState } from '@livekit/components-react';
import type { SFSymbol } from 'expo-symbols';

import type { VoiceConnectionState } from '../voice/voiceContext';
import { TAB_SEPARATOR } from './theme';
import type { DisplayTuning } from './tuning';

export const CONNECT_FAILED_MESSAGE = 'Could not connect. Try again.';

export type VoicePhase = 'off' | 'starting' | 'listening' | 'thinking' | 'speaking';

export interface TranscriptLine {
  id: string;
  type?: string;
  message: string;
}

export interface Exchange {
  question: string | null;
  answer: string | null;
  opening: string | null;
}

export interface LingeringAnswer {
  text: string;
  at: string | null;
}

export type VoiceCard =
  | { kind: 'prompt'; tab: string; icon: SFSymbol; title: string; detail: string | null }
  | { kind: 'answer'; tab: string; text: string };

export function voicePhase(connection: VoiceConnectionState, agent: AgentState): VoicePhase {
  if (connection === 'disconnected') return 'off';
  switch (agent) {
    case 'failed':
      return 'off';
    case 'disconnected':
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

export interface IdleInput {
  phase: VoicePhase;
  agentJoined: boolean;
  userSpeaking: boolean;
  answered: boolean;
}

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

export function failureMessage(agentJoined: boolean): string {
  return agentJoined ? 'Sunny stopped. Press Talk to try again.' : CONNECT_FAILED_MESSAGE;
}
