import { useRef, useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api } from '../backend/convexApi';
import type { TaskCard } from './model';
import { useTuning } from './TuningProvider';

export interface DisplayKeys {
  step: number;
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
  const [progress, setProgress] = useState<{ instanceId: string; index: number } | null>(null);
  const [doneBusy, setDoneBusy] = useState(false);
  const lastPress = useRef(0);

  const step = card !== null && progress?.instanceId === card.task.instanceId ? progress.index : 0;

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

  const pressTalk = (): void => {
    if (accept()) talk();
  };

  return { step, doneBusy, pressDone, pressTalk };
}
