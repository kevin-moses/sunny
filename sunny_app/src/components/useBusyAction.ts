// sunny_app/src/components/useBusyAction.ts
//
// Purpose: Hook for the busy flag and inline error message that wrap an async form action: run
// clears the message, sets busy, awaits the action, shows toMessage(error) when it throws (after
// the optional onError side effect, for example logging), and always clears busy. Used by the
// caregiver sign-in and onboarding screens and the pairing screen.
//
// Last modified: 2026-10-31

import { useState } from 'react';

/** What useBusyAction returns. */
export interface BusyAction {
  /** An action started by run is in progress. */
  busy: boolean;
  /** The message to show inline, or null. */
  message: string | null;
  /** Set or clear the message directly (for example to show a validation problem). */
  setMessage: (message: string | null) => void;
  /** Run an action with the busy flag and error message around it; never rejects. */
  run: (action: () => Promise<unknown>) => Promise<void>;
}

/**
 * purpose: Track the busy state and error message of async form actions.
 * @param toMessage: ((error: unknown) => string) Turns a thrown value into the text to show.
 * @param onError: ((error: unknown) => void, optional) Called with a thrown value before the
 *        message is set, for example to log it.
 * @return: (BusyAction) busy, message, setMessage and run.
 */
export function useBusyAction(
  toMessage: (error: unknown) => string,
  onError?: (error: unknown) => void,
): BusyAction {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * purpose: Run one action with the busy flag and inline error message around it.
   * @param action: (() => Promise<unknown>) The action; may throw.
   * @return: (Promise<void>) Resolves when the action finished and any failure is shown.
   */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      onError?.(error);
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return { busy, message, setMessage, run };
}
