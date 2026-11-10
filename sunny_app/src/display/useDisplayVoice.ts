// sunny_app/src/display/useDisplayVoice.ts
//
// Purpose: The home display's voice experience on top of the shared LiveKit session
// (VoiceProvider). The display never swaps to the phone's conversation screen; this hook turns
// the session into the voice card drawn on the paper panel (voiceModel.ts rules) and decides
// what the Talk key does. All waits come from the tuning values (useTuning).
// - Talk with no session starts one (one press; LiveKit opens the microphone right away and
//   keeps what is said while the agent joins). The card reads "One moment", "Listening", then
//   "Thinking" with the question heard, then the agent's answer as large text while it is
//   spoken. Talk is refused up front, in plain words, when the display is offline or the
//   microphone permission was refused.
// - Talk during a session, also while it is still connecting, ends it ("Stopped listening"):
//   the agent cannot be interrupted from the device, so a second press always means stop.
//   Ending aborts a start still waiting for its token, so a token that arrives later never
//   opens the microphone (VoiceProvider's abort path).
// - A session that has not reached the agent within startTimeoutMs is ended the same way, with
//   "Could not connect. Try again.", so an outage cannot leave "One moment" up (and the due
//   cue held back) indefinitely.
// - Once the agent has joined, the session ends by itself when nothing happens for a while
//   (voiceModel.idleTimeoutMs: firstQuestionMs before a question, followUpMs after an answer,
//   stuckMs while thinking or speaking). Continuous "speaking" (a TV in the room can sound like
//   the senior) holds the session open for at most speakingCapMs.
// - Whatever happens, a session never lasts longer than sessionMaxMs from its start (counted
//   from the Talk press, independent of activity): it then ends with a calm line. If the agent
//   is in the middle of speaking an answer to a question at that moment, the answer may finish
//   first, for at most ceilingGraceMs more. So the microphone is open for at most
//   sessionMaxMs + ceilingGraceMs per Talk press.
// - After the session, its last answer to a question stays on the card for answerLingerMs,
//   tabbed with the time it was given; an opening line the agent said before any question
//   never lingers. dismissAnswer clears it early (a newly due task takes priority). The
//   developer sheet's "Show sample answer" puts a sample here the same way.
// - Failures show in plain words on the status line and are announced: "Could not connect.
//   Try again." when the agent never joined, "Sunny stopped. Press Talk to try again." when it
//   failed after joining.
// Saying "done" is the agent's job, not this hook's; the Done key keeps working throughout.
// VoiceOver announces the status-line messages (useStatusMessage) but not the listening and
// thinking states, which it would speak into the open microphone; the voice card carries an
// accessibility label instead.
//
// Last modified: 2026-11-09

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clockTime } from '../day/format';
import { useConversation, useVoice } from '../voice/voiceContext';
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

/** Status line when the session ends, by a Talk press or by itself. */
export const STOPPED_MESSAGE = 'Stopped listening';

/** Status line when Talk is pressed but the microphone permission was refused. */
export const MIC_OFF_MESSAGE = 'The microphone is off. Ask your family to turn it on.';

/** Status line when Talk is pressed while the display has no connection. */
export const OFFLINE_MESSAGE = 'Not connected. Try again later.';

/** Status line when a session reaches its longest allowed length. */
export const CEILING_MESSAGE = 'Sunny stopped listening for now. Press Talk to ask again.';

/** What the display tracks about the current or last session. */
interface SessionTrack {
  active: boolean;
  /** Transcript lines from before the session started, left out of its exchange. */
  ignored: ReadonlySet<string>;
  /** The session's latest answer to a question, kept so it survives the transcript clearing. */
  answer: string | null;
  /** The agent joined the session. */
  joined: boolean;
}

/** What useDisplayVoice returns. */
export interface DisplayVoice {
  /** The voice card to draw on the panel, or null. */
  card: VoiceCard | null;
  /** A session is live (starting, listening, thinking or speaking). */
  active: boolean;
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
 * @param offline: (boolean) The display has no connection to the backend.
 * @param show: ((text: string) => void) Shows and announces a line on the status line.
 * @return: (DisplayVoice) The card, flags, status line and actions.
 */
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

  // A session already live when the display mounts owns the whole transcript.
  const [track, setTrack] = useState<SessionTrack>(() => ({
    active,
    ignored: new Set(),
    answer: null,
    joined: agentJoined,
  }));
  const [lingering, setLingering] = useState<LingeringAnswer | null>(null);
  const [seenSample, setSeenSample] = useState(sample?.id ?? 0);
  // The session reached sessionMaxMs.
  const [ceiling, setCeiling] = useState(false);
  // The senior's current stretch of speaking, and whether it has passed speakingCapMs.
  const { userSpeaking } = conversation;
  const [speech, setSpeech] = useState({ speaking: userSpeaking, capped: false });
  if (speech.speaking !== userSpeaking) setSpeech({ speaking: userSpeaking, capped: false });
  const exchange = useMemo(
    () => latestExchange(conversation.messages, track.ignored),
    [conversation.messages, track.ignored],
  );

  // Follow the session while rendering (React's pattern for reacting to a changed value): a
  // new session ignores the transcript so far and clears the old answer; a live session keeps
  // its latest answer (a new question clears it until it is answered) and notes the agent
  // joined; an ending session leaves its answer lingering. The kept answer survives LiveKit
  // clearing the transcript when the room disconnects.
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
  // The developer sheet asked for a sample answer.
  if (sample !== null && sample.id !== seenSample) {
    setSeenSample(sample.id);
    setLingering({ text: sample.text, at });
  }

  // The lingering answer leaves the panel answerLingerMs after it appeared.
  const lingerMs = tuning.answerLingerMs;
  useEffect(() => {
    if (lingering === null) return undefined;
    const timer = setTimeout(() => setLingering(null), lingerMs);
    return () => clearTimeout(timer);
  }, [lingering, lingerMs]);

  // The session's callbacks change identity with every LiveKit state change and tuning edit;
  // timers read them through refs so they depend only on their real inputs.
  const { connect, disconnect } = voice;
  const actions = useRef({ disconnect, show });
  // Set once a session has been ended by this hook, so one session is ended (and announced) once.
  const ended = useRef(false);
  useEffect(() => {
    actions.current = { disconnect, show };
  });
  useEffect(() => {
    if (active) ended.current = false;
  }, [active]);
  /**
   * purpose: End the session once, with a status line.
   * @param message: (string) The line to show.
   * @return: (void)
   */
  const endWith = useCallback((message: string): void => {
    if (ended.current) return;
    ended.current = true;
    void actions.current.disconnect();
    actions.current.show(message);
  }, []);

  // Give up on a session that has not reached the agent within startTimeoutMs of the press.
  const connecting = active && !agentJoined;
  const startTimeoutMs = tuning.startTimeoutMs;
  useEffect(() => {
    if (!connecting) return undefined;
    const timer = setTimeout(() => endWith(CONNECT_FAILED_MESSAGE), startTimeoutMs);
    return () => clearTimeout(timer);
  }, [connecting, startTimeoutMs, endWith]);

  // Continuous speaking holds the session open for at most speakingCapMs.
  const speakingCapMs = tuning.speakingCapMs;
  useEffect(() => {
    if (!userSpeaking) return undefined;
    const timer = setTimeout(
      () => setSpeech((s) => (s.speaking ? { ...s, capped: true } : s)),
      speakingCapMs,
    );
    return () => clearTimeout(timer);
  }, [userSpeaking, speakingCapMs]);

  // End a session that stays quiet: the timer restarts whenever anything changes.
  const timeout = idleTimeoutMs(
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
  useEffect(() => {
    if (timeout === null) return undefined;
    const timer = setTimeout(() => endWith(STOPPED_MESSAGE), timeout);
    return () => clearTimeout(timer);
  }, [timeout, activity, endWith]);

  // The absolute ceiling: sessionMaxMs after the session started, whatever is happening. An
  // answer being spoken may finish first, for at most ceilingGraceMs.
  const sessionMaxMs = tuning.sessionMaxMs;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => setCeiling(true), sessionMaxMs);
    return () => clearTimeout(timer);
  }, [active, sessionMaxMs]);
  const answering = phase === 'speaking' && exchange.answer !== null;
  const ceilingNow = active && ceiling && !answering;
  useEffect(() => {
    if (ceilingNow) endWith(CEILING_MESSAGE);
  }, [ceilingNow, endWith]);
  const graceMs = tuning.ceilingGraceMs;
  const inGrace = active && ceiling;
  useEffect(() => {
    if (!inGrace) return undefined;
    const timer = setTimeout(() => endWith(CEILING_MESSAGE), graceMs);
    return () => clearTimeout(timer);
  }, [inGrace, graceMs, endWith]);

  // A failed session is reported in plain words (once per failure).
  const { error } = voice;
  const joined = track.joined;
  useEffect(() => {
    if (error !== null) actions.current.show(failureMessage(joined));
  }, [error, joined]);

  /**
   * purpose: The Talk key: end a live (or connecting) session, otherwise start one unless the
   *          display is offline or the microphone is refused.
   * @return: (void)
   */
  const talk = useCallback((): void => {
    if (active) {
      endWith(STOPPED_MESSAGE);
    } else if (offline) {
      show(OFFLINE_MESSAGE);
    } else if (micAllowed === false) {
      show(MIC_OFF_MESSAGE);
    } else {
      void connect();
    }
  }, [active, offline, micAllowed, connect, endWith, show]);

  /**
   * purpose: Take a lingering answer off the panel.
   * @return: (void)
   */
  const dismissAnswer = useCallback((): void => setLingering(null), [setLingering]);

  let status: string | null = null;
  if (voice.connectionState === 'reconnecting') status = 'Reconnecting';
  else if (active) status = 'Press Talk to stop';

  return { card: voiceCard(phase, exchange, lingering), active, status, talk, dismissAnswer };
}
