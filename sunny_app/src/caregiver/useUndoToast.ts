import { useTimedValue } from '../components/useTimedValue';

export const UNDO_TOAST_MS = 5000;

export interface UndoToast<T> {
  id: T | null;
  show: (id: T) => void;
  dismiss: () => void;
}

export function useUndoToast<T>(durationMs: number = UNDO_TOAST_MS): UndoToast<T> {
  const { value, show, dismiss } = useTimedValue<T>(durationMs);
  return { id: value, show, dismiss };
}
