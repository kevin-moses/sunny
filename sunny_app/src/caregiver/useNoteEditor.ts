import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TaskInstanceId } from '../backend/convexApi';
import { noteFromInput, shouldSaveNote } from './format';
import { useFlushOnLeave } from './useFlushOnLeave';

export interface NoteTarget {
  rowId: string;
  instanceId: TaskInstanceId;
  note: string | null;
}

export interface OpenNote {
  rowId: string;
  initialDraft: string;
}

export interface NoteEditor {
  open: OpenNote | null;
  toggle: (target: NoteTarget) => void;
  setDraft: (text: string) => void;
  close: (rowId?: string) => void;
}

export function useNoteEditor(
  saveNote: (instanceId: TaskInstanceId, note: string | undefined) => Promise<boolean>,
): NoteEditor {
  const [open, setOpen] = useState<OpenNote | null>(null);
  const targetRef = useRef<NoteTarget | null>(null);
  const draftRef = useRef('');
  const failedRef = useRef<Partial<Record<string, string>>>({});
  const saveRef = useRef(saveNote);

  useEffect(() => {
    saveRef.current = saveNote;
  });

  const close = useCallback((rowId?: string): void => {
    const target = targetRef.current;
    if (target === null) return;
    if (rowId !== undefined && target.rowId !== rowId) return;
    targetRef.current = null;
    setOpen(null);
    const draft = draftRef.current;
    if (!shouldSaveNote(draft, target.note)) {
      delete failedRef.current[target.instanceId];
      return;
    }
    failedRef.current[target.instanceId] = draft;
    void saveRef.current(target.instanceId, noteFromInput(draft)).then((saved) => {
      if (saved && failedRef.current[target.instanceId] === draft) {
        delete failedRef.current[target.instanceId];
      }
    });
  }, []);

  const flush = useCallback((): void => close(), [close]);

  const toggle = useCallback(
    (target: NoteTarget): void => {
      const wasOpen = targetRef.current?.rowId === target.rowId;
      close();
      if (wasOpen) return;
      const initialDraft = failedRef.current[target.instanceId] ?? target.note ?? '';
      draftRef.current = initialDraft;
      targetRef.current = target;
      setOpen({ rowId: target.rowId, initialDraft });
    },
    [close],
  );

  const setDraft = useCallback((text: string): void => {
    draftRef.current = text;
  }, []);

  useFlushOnLeave(flush);

  return useMemo(() => ({ open, toggle, setDraft, close }), [open, toggle, setDraft, close]);
}
