// sunny_app/src/caregiver/useNoteEditor.ts
//
// Purpose: The inline note editor's state for the caregiver Home screen. One row's editor is open
// at a time and it autosaves: there is no Save or Cancel, and a draft is never discarded. The
// draft is saved (when its trimmed text differs from the task's note; blank clears the note) on
// every way the editor closes: tapping the row's text again, opening another row's editor, the
// field losing focus (this covers the keyboard's Done, tapping outside and scrolling, because
// the screen's scroll view dismisses the keyboard on drag), the app going to the background and
// unmounting (useFlushOnLeave). A save that fails keeps its draft so that reopening the row shows
// it (and closing it retries); a save that succeeds forgets the draft only if it is still the
// text that was saved. The field reports its row id when it loses focus and close(rowId) acts
// only when that row is the open one, so a late blur from a row that is unmounting cannot close
// the next row's editor. The typed text lives only in a ref (the field is uncontrolled),
// so typing does not re-render anything. The only state is which row is open and its starting
// text; toggle, setDraft and close keep their identity between renders.
//
// Last modified: 2026-11-01

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TaskInstanceId } from '../backend/convexApi';
import { noteFromInput, shouldSaveNote } from './format';
import { useFlushOnLeave } from './useFlushOnLeave';

/** The row whose editor is opening: its row id, task instance and current note. */
export interface NoteTarget {
  rowId: string;
  instanceId: TaskInstanceId;
  note: string | null;
}

/** The open editor: its row and the text the field starts with. */
export interface OpenNote {
  rowId: string;
  /** The current note, or a draft that failed to save. */
  initialDraft: string;
}

/** What useNoteEditor returns. */
export interface NoteEditor {
  /** The open editor; null when none is open. */
  open: OpenNote | null;
  /** Open the row's editor, or close (and save) it when it is the open one. */
  toggle: (target: NoteTarget) => void;
  /** Record the text typed in the open editor. */
  setDraft: (text: string) => void;
  /**
   * Close the open editor, saving its draft when it changed; does nothing when none is open.
   * With a row id, does nothing unless that row is the open one.
   */
  close: (rowId?: string) => void;
}

/**
 * purpose: Manage the autosaving inline note editor.
 * @param saveNote: ((id, note) => Promise<boolean>) Saves or clears a note; resolves true when
 *        saved. The latest function is always used.
 * @return: (NoteEditor) The open editor and the toggle, setDraft and close actions.
 */
export function useNoteEditor(
  saveNote: (instanceId: TaskInstanceId, note: string | undefined) => Promise<boolean>,
): NoteEditor {
  const [open, setOpen] = useState<OpenNote | null>(null);
  const targetRef = useRef<NoteTarget | null>(null);
  const draftRef = useRef('');
  /** Drafts whose save failed (or is still running), by instance id. */
  const failedRef = useRef<Partial<Record<string, string>>>({});
  const saveRef = useRef(saveNote);

  useEffect(() => {
    saveRef.current = saveNote;
  });

  /**
   * purpose: Close the open editor and save its draft if it changed.
   * @param rowId: (string, optional) When given, close only if this is the open row.
   * @return: (void)
   */
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

  /**
   * purpose: Close whatever editor is open (used when the app leaves the screen).
   * @return: (void)
   */
  const flush = useCallback((): void => close(), [close]);

  /**
   * purpose: Open a row's editor (saving any other open one first), or close it if it is open.
   * @param target: (NoteTarget) The row, its task instance and its current note.
   * @return: (void)
   */
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

  /**
   * purpose: Remember the text typed in the editor.
   * @param text: (string) The field's text.
   * @return: (void)
   */
  const setDraft = useCallback((text: string): void => {
    draftRef.current = text;
  }, []);

  useFlushOnLeave(flush);

  return useMemo(() => ({ open, toggle, setDraft, close }), [open, toggle, setDraft, close]);
}
