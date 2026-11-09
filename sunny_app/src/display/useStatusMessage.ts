// sunny_app/src/display/useStatusMessage.ts
//
// Purpose: The short message shown on the home display's status line between the Done and
// Talk keys (a key's result, a voice failure). Each message stays for MESSAGE_MS, or until
// the next one replaces it, and is announced to VoiceOver when it is shown.
//
// Last modified: 2026-11-09

import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** How long (ms) a message stays on screen. */
const MESSAGE_MS = 10_000;

/** What useStatusMessage returns. */
export interface StatusMessage {
  /** The message on screen, or null. */
  message: string | null;
  /** Show a message for MESSAGE_MS and announce it. */
  show: (text: string) => void;
}

/**
 * purpose: Hold the status line's current message and clear it after MESSAGE_MS.
 * @return: (StatusMessage) The message and the function that shows one.
 */
export function useStatusMessage(): StatusMessage {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  /**
   * purpose: Show a message for MESSAGE_MS and announce it.
   * @param text: (string) The message.
   * @return: (void)
   */
  const show = useCallback((text: string): void => {
    clearTimeout(timer.current);
    setMessage(text);
    AccessibilityInfo.announceForAccessibility(text);
    timer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  }, []);

  return { message, show };
}
