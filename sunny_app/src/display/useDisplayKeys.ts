// sunny_app/src/display/useDisplayKeys.ts
//
// Purpose: What the home display's Done and Talk keys do. Done on a multi-step task moves to
// the next step (kept on this device until the backend tracks steps); Done on a one-step
// task, or on the last step, confirms the Now task by its instance id
// (instances.confirmTaskInstance), so it can only confirm the task the screen shows. With
// nothing waiting, Done says so without calling the backend. Done works the same during and
// after a voice session. Talk hands over to the display's voice layer (useDisplayVoice), which
// starts or ends a session. A second press of either key within the tuned pressGapMs is
// ignored so a tremor or a double tap cannot skip a step, and Done is ignored while a confirm
// is in flight ("Saving" shows until it lands, which offline is when the connection is back).
// Results go to the status line (useStatusMessage), which shows and announces them.
//
// Last modified: 2026-11-09

import { useRef, useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api } from '../backend/convexApi';
import type { TaskCard } from './model';
import { useTuning } from './TuningProvider';

/** What useDisplayKeys returns. */
export interface DisplayKeys {
  /** The current step index of the Now task (0 when it has no steps). */
  step: number;
  /** A confirm is in flight. */
  doneBusy: boolean;
  pressDone: () => void;
  pressTalk: () => void;
}

/**
 * purpose: Wire the display's Done and Talk keys.
 * @param card: (TaskCard | null) The task on the Now card, or null when nothing is waiting.
 * @param onPress: (() => void) Called on every accepted press (the screen shows the Now page).
 * @param show: ((text: string) => void) Shows and announces a line on the status line.
 * @param talk: (() => void) The Talk key's action (useDisplayVoice's talk).
 * @return: (DisplayKeys) The step, the Done busy flag and the press handlers.
 */
export function useDisplayKeys(
  card: TaskCard | null,
  onPress: () => void,
  show: (text: string) => void,
  talk: () => void,
): DisplayKeys {
  const { pressGapMs } = useTuning();
  const [progress, setProgress] = useState<{ instanceId: string; index: number } | null>(null);
  const [doneBusy, setDoneBusy] = useState(false);
  const lastPress = useRef(0);

  const step = card !== null && progress?.instanceId === card.task.instanceId ? progress.index : 0;

  /**
   * purpose: Accept a press unless it follows the last one too closely.
   * @return: (boolean) True when the press counts.
   */
  const accept = (): boolean => {
    const now = Date.now();
    if (now - lastPress.current < pressGapMs) return false;
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
   * purpose: The Talk key: hand the press to the voice layer.
   * @return: (void)
   */
  const pressTalk = (): void => {
    if (accept()) talk();
  };

  return { step, doneBusy, pressDone, pressTalk };
}
