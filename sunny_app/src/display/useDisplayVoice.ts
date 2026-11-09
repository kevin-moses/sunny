// sunny_app/src/display/useDisplayVoice.ts
//
// Purpose: The home display's voice experience on top of the shared LiveKit session
// (VoiceProvider). The display never swaps to the phone's conversation screen; this hook turns
// the session into the voice card drawn on the paper panel (voiceModel.ts rules) and decides
// what the Talk key does:
// - Talk with no session starts one (one press; LiveKit opens the microphone right away and
//   keeps what is said while the agent joins). The card reads "Listening", then "Thinking"
//   with the question heard, then the agent's answer as large text while it is spoken.
// - Talk while the session is starting is ignored (the key is dimmed). Talk during a live
//   session ends it ("Stopped listening"): the agent cannot be interrupted from the device,
//   so a second press always means stop, which is easy to predict.
// - The session ends by itself when nothing happens for a while (voiceModel.idleTimeoutMs:
//   FIRST_QUESTION_MS before a question, FOLLOW_UP_MS after an answer); the microphone is
//   never left open.
// - After the session, its last answer stays on the card for ANSWER_LINGER_MS, tabbed with the
//   time it was given; dismissAnswer clears it early (a newly due task takes priority).
// - Failures show in plain words on the status line and are announced: a refused microphone
//   (checked before connecting), "Could not connect. Try again." when the session never
//   opened the microphone, "Sunny stopped. Press Talk to try again." when it failed later.
// Saying "done" is the agent's job, not this hook's; the Done key keeps working throughout.
// VoiceOver announces the status-line messages (useStatusMessage) but not the listening and
// thinking states, which it would speak into the open microphone; the voice card carries an
// accessibility label instead.
//
// Last modified: 2026-11-09

import { useCallback, useEffect, useMemo, useState } from 'react';

import { clockTime } from '../day/format';
import { useConversation, useVoice } from '../voice/voiceContext';
import { useMicrophoneAllowed } from './useMicrophoneAllowed';
import {
  ANSWER_LINGER_MS,
  failureMessage,
  idleTimeoutMs,
  latestExchange,
  voiceCard,
  voicePhase,
} from './voiceModel';
import type { LingeringAnswer, VoiceCard } from './voiceModel';

/** Status line when the session ends, by a Talk press or by itself. */
export const STOPPED_MESSAGE = 'Stopped listening';

/** Status line when Talk is pressed but the microphone permission was refused. */
export const MIC_OFF_MESSAGE = 'The microphone is off. Ask your family to turn it on.';

/** What the display tracks about the current or last session. */
interface SessionTrack {
  active: boolean;
  /** Transcript lines from before the session started, left out of its exchange. */
  ignored: ReadonlySet<string>;
  /** The session's latest answer, kept so it survives the transcript being cleared. */
  answer: string | null;
  /** The session opened the microphone. */
  heard: boolean;
}

/** What useDisplayVoice returns. */
export interface DisplayVoice {
  /** The voice card to draw on the panel, or null. */
  card: VoiceCard | null;
  /** A session is live (starting, listening, thinking or speaking). */
  active: boolean;
  /** The session is starting; the Talk key shows as busy. */
  busy: boolean;
  /** A standing status line while a session is live, or null. */
  status: string | null;
  /** The Talk key's action. */
  talk: () => void;
  /** Clear a lingering answer. */
  dismissAnswer: () => void;
}

/**
 * purpose: Drive the display's voice card and Talk key from the voice session.
 * @param clock: (string | null) The household-local time now, "HH:MM", stamped on answers.
 * @param show: ((text: string) => void) Shows and announces a line on the status line.
 * @return: (DisplayVoice) The card, flags, status line and actions.
 */
export function useDisplayVoice(clock: string | null, show: (text: string) => void): DisplayVoice {
  const voice = useVoice();
  const conversation = useConversation();
  const micAllowed = useMicrophoneAllowed();
  const phase = voicePhase(voice.connectionState, conversation.agentState);
  const active = phase !== 'off';

  // A session already live when the display mounts owns the whole transcript.
  const [track, setTrack] = useState<SessionTrack>(() => ({
    active,
    ignored: new Set(),
    answer: null,
    heard: false,
  }));
  const [lingering, setLingering] = useState<LingeringAnswer | null>(null);
  const exchange = useMemo(
    () => latestExchange(conversation.messages, track.ignored),
    [conversation.messages, track.ignored],
  );

  // Follow the session while rendering (React's pattern for reacting to a changed value): a
  // new session ignores the transcript so far and clears the old answer; a live session keeps
  // its latest answer (a new question clears it until it is answered) and notes the
  // microphone opened; an ending session leaves its answer lingering. The kept answer
  // survives LiveKit clearing the transcript when the room disconnects.
  if (active && !track.active) {
    setTrack({
      active: true,
      ignored: new Set(conversation.messages.map((m) => m.id)),
      answer: null,
      heard: false,
    });
    setLingering(null);
  } else if (!active && track.active) {
    setTrack({ ...track, active: false });
    if (track.answer !== null) {
      setLingering({ text: track.answer, at: clock === null ? null : clockTime(clock) });
    }
  } else if (active) {
    const cleared = exchange.question === null && exchange.answer === null;
    const answer = cleared ? track.answer : exchange.answer;
    const heard = track.heard || phase !== 'starting';
    if (answer !== track.answer || heard !== track.heard) setTrack({ ...track, answer, heard });
  }

  // The lingering answer leaves the panel ANSWER_LINGER_MS after the session ended.
  useEffect(() => {
    if (lingering === null) return undefined;
    const timer = setTimeout(() => setLingering(null), ANSWER_LINGER_MS);
    return () => clearTimeout(timer);
  }, [lingering]);

  // End a session that stays quiet: the timer restarts whenever anything changes.
  const timeout = idleTimeoutMs(phase, conversation.userSpeaking, track.answer !== null);
  const last = conversation.messages.at(-1);
  const activity = `${phase}|${conversation.messages.length}|${last?.message.length ?? 0}`;
  const { disconnect } = voice;
  useEffect(() => {
    if (timeout === null) return undefined;
    const timer = setTimeout(() => {
      void disconnect();
      show(STOPPED_MESSAGE);
    }, timeout);
    return () => clearTimeout(timer);
  }, [timeout, activity, disconnect, show]);

  // A failed session is reported in plain words.
  const { error } = voice;
  const heard = track.heard;
  useEffect(() => {
    if (error !== null) show(failureMessage(heard));
  }, [error, heard, show]);

  const { connect } = voice;
  const talk = useCallback((): void => {
    if (phase === 'starting') return;
    if (active) {
      void disconnect();
      show(STOPPED_MESSAGE);
      return;
    }
    if (micAllowed === false) {
      show(MIC_OFF_MESSAGE);
      return;
    }
    void connect();
  }, [phase, active, micAllowed, connect, disconnect, show]);

  const dismissAnswer = useCallback((): void => setLingering(null), [setLingering]);

  let status: string | null = null;
  if (voice.connectionState === 'reconnecting') status = 'Reconnecting';
  else if (active && phase !== 'starting') status = 'Press Talk to stop';

  return {
    card: voiceCard(phase, exchange, lingering),
    active,
    busy: phase === 'starting',
    status,
    talk,
    dismissAnswer,
  };
}
