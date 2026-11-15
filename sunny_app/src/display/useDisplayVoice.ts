import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clockTime } from '../day/format';
import { useConversation, useVoice } from '../voice/voiceContext';
import { useLatest, useTimeout } from './timers';
import { useSampleAnswer, useTuning } from './TuningProvider';
import { useMicrophoneAllowed } from './useMicrophoneAllowed';
import {
  CONNECT_FAILED_MESSAGE,
  failureMessage,
  idleTimeoutMs,
  latestExchange,
  voiceCard,
  voicePhase,
} from './voiceModel';
import type { LingeringAnswer, VoiceCard } from './voiceModel';

export const STOPPED_MESSAGE = 'Stopped listening';

export const MIC_OFF_MESSAGE = 'The microphone is off. Ask your family to turn it on.';

export const OFFLINE_MESSAGE = 'Not connected. Try again later.';

export const CEILING_MESSAGE = 'Sunny stopped listening for now. Press Talk to ask again.';

interface SessionTrack {
  active: boolean;
  ignored: ReadonlySet<string>;
  answer: string | null;
  joined: boolean;
}

export interface DisplayVoice {
  card: VoiceCard | null;
  active: boolean;
  status: string | null;
  talk: () => void;
  dismissAnswer: () => void;
}

export function useDisplayVoice(
  clock: string | null,
  offline: boolean,
  show: (text: string) => void,
): DisplayVoice {
  const voice = useVoice();
  const conversation = useConversation();
  const tuning = useTuning();
  const sample = useSampleAnswer();
  const micAllowed = useMicrophoneAllowed();
  const phase = voicePhase(voice.connectionState, conversation.agentState);
  const active = phase !== 'off';
  const { agentJoined } = conversation;
  const at = clock === null ? null : clockTime(clock);

  const [track, setTrack] = useState<SessionTrack>(() => ({
    active,
    ignored: new Set(),
    answer: null,
    joined: agentJoined,
  }));
  const [lingering, setLingering] = useState<LingeringAnswer | null>(null);
  const [seenSample, setSeenSample] = useState(sample?.id ?? 0);
  const [ceiling, setCeiling] = useState(false);
  const { userSpeaking } = conversation;
  const [speech, setSpeech] = useState({ speaking: userSpeaking, capped: false });
  if (speech.speaking !== userSpeaking) setSpeech({ speaking: userSpeaking, capped: false });
  const exchange = useMemo(
    () => latestExchange(conversation.messages, track.ignored),
    [conversation.messages, track.ignored],
  );

  if (active && !track.active) {
    setTrack({
      active: true,
      ignored: new Set(conversation.messages.map((m) => m.id)),
      answer: null,
      joined: agentJoined,
    });
    setLingering(null);
    setCeiling(false);
  } else if (!active && track.active) {
    setTrack({ ...track, active: false });
    if (track.answer !== null) setLingering({ text: track.answer, at });
  } else if (active) {
    const cleared = exchange.question === null && exchange.answer === null;
    const answer = cleared ? track.answer : exchange.answer;
    const joined = track.joined || agentJoined;
    if (answer !== track.answer || joined !== track.joined) setTrack({ ...track, answer, joined });
  }
  if (sample !== null && sample.id !== seenSample) {
    setSeenSample(sample.id);
    setLingering({ text: sample.text, at });
  }

  useTimeout(
    () => setLingering(null),
    lingering === null ? null : tuning.answerLingerMs,
    lingering,
  );

  const ended = useRef(false);
  useEffect(() => {
    if (active) ended.current = false;
  }, [active]);
  const endWith = (message: string): void => {
    if (ended.current) return;
    ended.current = true;
    void voice.disconnect();
    show(message);
  };

  const connecting = active && !(track.joined || agentJoined);
  useTimeout(() => endWith(CONNECT_FAILED_MESSAGE), connecting ? tuning.startTimeoutMs : null);

  useTimeout(
    () => setSpeech((s) => (s.speaking ? { ...s, capped: true } : s)),
    userSpeaking ? tuning.speakingCapMs : null,
  );

  const idleMs = idleTimeoutMs(
    {
      phase,
      agentJoined,
      userSpeaking: userSpeaking && !speech.capped,
      answered: track.answer !== null,
    },
    tuning,
  );
  const last = conversation.messages.at(-1);
  const activity = `${phase}|${conversation.messages.length}|${last?.message.length ?? 0}`;
  useTimeout(() => endWith(STOPPED_MESSAGE), idleMs, activity);

  useTimeout(() => setCeiling(true), active ? tuning.sessionMaxMs : null);
  const answering = phase === 'speaking' && exchange.answer !== null;
  const ceilingNow = active && ceiling && !answering;
  const endRef = useLatest(endWith);
  useEffect(() => {
    if (ceilingNow) endRef.current(CEILING_MESSAGE);
  }, [ceilingNow, endRef]);
  useTimeout(() => endWith(CEILING_MESSAGE), active && ceiling ? tuning.ceilingGraceMs : null);

  const { error } = voice;
  const joined = track.joined;
  const showRef = useLatest(show);
  useEffect(() => {
    if (error !== null) showRef.current(failureMessage(joined));
  }, [error, joined, showRef]);

  const talk = (): void => {
    if (active) endWith(STOPPED_MESSAGE);
    else if (offline) show(OFFLINE_MESSAGE);
    else if (micAllowed === false) show(MIC_OFF_MESSAGE);
    else void voice.connect();
  };

  const dismissAnswer = useCallback((): void => setLingering(null), [setLingering]);

  let status: string | null = null;
  if (voice.connectionState === 'reconnecting') status = 'Reconnecting';
  else if (active) status = 'Press Talk to stop';

  return { card: voiceCard(phase, exchange, lingering), active, status, talk, dismissAnswer };
}
