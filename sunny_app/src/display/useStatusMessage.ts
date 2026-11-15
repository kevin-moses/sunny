import { useCallback } from 'react';
import { AccessibilityInfo } from 'react-native';

import { useTimedValue } from '../components/useTimedValue';
import { useTuning } from './TuningProvider';

export interface StatusMessage {
  message: string | null;
  show: (text: string) => void;
}

export function useStatusMessage(): StatusMessage {
  const { messageMs } = useTuning();
  const timed = useTimedValue<string>(messageMs);
  const showTimed = timed.show;

  const show = useCallback(
    (text: string): void => {
      showTimed(text);
      AccessibilityInfo.announceForAccessibility(text);
    },
    [showTimed],
  );

  return { message: timed.value, show };
}
