import { useState } from 'react';

export interface BusyAction {
  busy: boolean;
  message: string | null;
  setMessage: (message: string | null) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

export function useBusyAction(
  toMessage: (error: unknown) => string,
  onError?: (error: unknown) => void,
): BusyAction {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
