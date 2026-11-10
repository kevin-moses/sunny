// sunny_app/src/display/useStatusMessage.ts
//
// Purpose: The short message shown on the home display's status line between the Done and
// Talk keys (a key's result, a voice failure). Each message stays for the tuned messageMs,
// or until the next one replaces it, and is announced to VoiceOver when it is shown. The
// timing is the caregiver app's useUndoToast (show, replace and restart, cleared on unmount,
// nothing after unmount) holding a message instead of a task.
//
// Last modified: 2026-11-09

import { useCallback } from 'react';
import { AccessibilityInfo } from 'react-native';

import { useUndoToast } from '../caregiver/useUndoToast';
import { useTuning } from './TuningProvider';

/** What useStatusMessage returns. */
export interface StatusMessage {
  /** The message on screen, or null. */
  message: string | null;
  /** Show a message for the tuned messageMs and announce it. */
  show: (text: string) => void;
}

/**
 * purpose: Hold the status line's current message and clear it after the tuned messageMs.
 * @return: (StatusMessage) The message and the function that shows one.
 */
export function useStatusMessage(): StatusMessage {
  const { messageMs } = useTuning();
  const toast = useUndoToast<string>(messageMs);
  const showToast = toast.show;

  /**
   * purpose: Show a message for messageMs and announce it.
   * @param text: (string) The message.
   * @return: (void)
   */
  const show = useCallback(
    (text: string): void => {
      showToast(text);
      AccessibilityInfo.announceForAccessibility(text);
    },
    [showToast],
  );

  return { message: toast.id, show };
}
