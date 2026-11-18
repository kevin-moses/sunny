import { useRef, useState } from 'react';

import { isDone, stepIndex } from '../day/format';

import { callMutation, toBackendError } from '../backend/api';
import { api } from '../backend/convexApi';
import type { TaskCard } from './model';
import { useTuning } from './TuningProvider';

export interface DisplayKeys {
  doneBusy: boolean;
  pressDone: () => void;
  pressTalk: () => void;
}

export function useDisplayKeys(
  card: TaskCard | null,
  onPress: () => void,
  show: (text: string) => void,
  talk: () => void,
): DisplayKeys {
  const { pressGapMs } = useTuning();
  const [doneBusy, setDoneBusy] = useState(false);
  const lastPress = useRef(0);

  const accept = (): boolean => {
    const now = Date.now();
    if (now - lastPress.current < pressGapMs) return false;
    lastPress.current = now;
    onPress();
    return true;
  };

  const confirm = async (task: TaskCard['task']): Promise<void> => {
    setDoneBusy(true);
    show('Saving');
    try {
      const row = await callMutation(api.instances.confirmTaskInstance, {
        instanceId: task.instanceId,
        via: 'button',
        step: stepIndex(task),
      });
      show(
        isDone(row) || task.step === null
          ? `Checked off: ${task.displayLabel}`
          : `Step ${task.step.index + 1} done`,
      );
    } catch (error) {
      show(toBackendError(error).message);
    } finally {
      setDoneBusy(false);
    }
  };

  const pressDone = (): void => {
    if (doneBusy || !accept()) return;
    if (card === null) {
      show('Nothing to mark done right now');
      return;
    }
    void confirm(card.task);
  };

  const pressTalk = (): void => {
    if (accept()) talk();
  };

  return { doneBusy, pressDone, pressTalk };
}
