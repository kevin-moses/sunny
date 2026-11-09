// sunny_app/src/display/useDisplayKeys.ts
//
// Purpose: What the home display's Done and Talk keys do, and the short status line shown
// between them. Done on a multi-step task moves to the next step (kept on this device until
// the backend tracks steps); Done on a one-step task, or on the last step, confirms the Now
// task by its instance id (instances.confirmTaskInstance), so it can only confirm the task the
// screen shows. With nothing waiting, Done says so without calling the backend. Talk starts a
// voice session. A second press within PRESS_GAP_MS is ignored so a tremor or a double tap
// cannot skip a step, and Done is ignored while a confirm is in flight ("Saving" shows until
// it lands, which offline is when the connection is back). Each result is shown for
// MESSAGE_MS and announced to VoiceOver.
//
// Last modified: 2026-11-07

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { callMutation, toBackendError } from '../backend/api';
import { api } from '../backend/convexApi';
import { useVoice } from '../voice/voiceContext';
import type { TaskCard } from './model';

/** Presses closer together than this (ms) count as one. */
const PRESS_GAP_MS = 700;

/** How long (ms) a key's result stays on screen. */
const MESSAGE_MS = 10_000;

/** What useDisplayKeys returns. */
export interface DisplayKeys {
  /** The current step index of the Now task (0 when it has no steps). */
  step: number;
  /** The status line to show, or null. */
  message: string | null;
  /** A confirm is in flight. */
  doneBusy: boolean;
  /** A voice session is connecting. */
  talkBusy: boolean;
  pressDone: () => void;
  pressTalk: () => void;
}

/**
 * purpose: Wire the display's Done and Talk keys.
 * @param card: (TaskCard | null) The task on the Now card, or null when nothing is waiting.
 * @param onPress: (() => void) Called on every accepted press (the screen shows the Now page).
 * @return: (DisplayKeys) The step, status line, busy flags and press handlers.
 */
export function useDisplayKeys(card: TaskCard | null, onPress: () => void): DisplayKeys {
  const voice = useVoice();
  const [progress, setProgress] = useState<{ instanceId: string; index: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [doneBusy, setDoneBusy] = useState(false);
  const lastPress = useRef(0);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(clearTimer.current), []);

  const step = card !== null && progress?.instanceId === card.task.instanceId ? progress.index : 0;

  /**
   * purpose: Show a status line for MESSAGE_MS and announce it.
   * @param text: (string) The line.
   * @return: (void)
   */
  const show = (text: string): void => {
    clearTimeout(clearTimer.current);
    setMessage(text);
    AccessibilityInfo.announceForAccessibility(text);
    clearTimer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  };

  /**
   * purpose: Accept a press unless it follows the last one too closely.
   * @return: (boolean) True when the press counts.
   */
  const accept = (): boolean => {
    const now = Date.now();
    if (now - lastPress.current < PRESS_GAP_MS) return false;
    lastPress.current = now;
    onPress();
    return true;
  };

  /**
   * purpose: Confirm the Now task on the backend and show the outcome.
   * @param task: (TaskCard['task']) The task on the card.
   * @return: (Promise<void>) Resolves when the outcome is shown; never rejects.
   */
  const confirm = async (task: TaskCard['task']): Promise<void> => {
    setDoneBusy(true);
    // Offline, Convex holds the call until the connection is back, so say it is on its way.
    show('Saving');
    try {
      await callMutation(api.instances.confirmTaskInstance, {
        instanceId: task.instanceId,
        via: 'button',
      });
      show(`Checked off: ${task.displayLabel}`);
    } catch (error) {
      show(toBackendError(error).message);
    } finally {
      setDoneBusy(false);
    }
  };

  /**
   * purpose: The Done key: next step of a multi-step task, otherwise confirm the Now task.
   * @return: (void)
   */
  const pressDone = (): void => {
    if (doneBusy || !accept()) return;
    if (card === null) {
      show('Nothing to mark done right now');
      return;
    }
    if (card.steps !== null && step < card.steps.length - 1) {
      setProgress({ instanceId: card.task.instanceId, index: step + 1 });
      show(`Step ${step + 1} done`);
      return;
    }
    void confirm(card.task);
  };

  /**
   * purpose: The Talk key: start a voice session.
   * @return: (void)
   */
  const pressTalk = (): void => {
    if (voice.connectionState === 'connecting' || !accept()) return;
    void voice.connect();
  };

  return {
    step,
    message,
    doneBusy,
    talkBusy: voice.connectionState === 'connecting',
    pressDone,
    pressTalk,
  };
}
