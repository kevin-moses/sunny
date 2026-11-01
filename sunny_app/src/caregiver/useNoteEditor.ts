// sunny_app/src/caregiver/useNoteEditor.ts
//
// Purpose: The inline note editor's state for the caregiver Home screen. One row's editor is open
// at a time and it autosaves: there is no Save or Cancel, and a draft is never discarded. The
// draft is saved (when its trimmed text differs from the task's note; blank clears the note) on
// every way the editor closes: tapping the row's text again, opening another row's editor, the
// keyboard's Done, the field losing focus (tapping outside dismisses the keyboard), scrolling,
// the app going to the background, the screen no longer being the active tab, and unmounting. A
// save that fails keeps its draft so that reopening the row shows it (and closing it retries).
// The typed text lives in a ref so typing does not re-render the screen.
//
// Last modified: 2026-11-01

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { TaskInstanceId } from '../backend/convexApi';
import { noteFromInput, shouldSaveNote } from './format';

/** The row whose editor is opening: its row id, task instance and current note. */
export interface NoteTarget {
  rowId: string;
  instanceId: TaskInstanceId;
  note: string | null;
}

/** What useNoteEditor returns. */
export interface NoteEditor {
  /** The row id whose editor is open; null when none. */
  openRowId: string | null;
  /** The text the open editor starts with: the current note or a draft that failed to save. */
  initialDraft: string;
  /** Open the row's editor, or close (and save) it when it is the open one. */
  toggle: (target: NoteTarget) => void;
  /** Record the text typed in the open editor. */
  setDraft: (text: string) => void;
  /** Close the open editor, saving its draft when it changed; does nothing when none is open. */
  close: () => void;
}

/**
 * purpose: Manage the autosaving inline note editor.
 * @param saveNote: ((id, note) => Promise<boolean>) Saves or clears a note; resolves true when
 *        saved. The latest function is always used.
 * @param active: (boolean) Whether the screen is the visible tab; going inactive closes the editor.
 * @return: (NoteEditor) The open row, its starting text and the toggle, setDraft and close actions.
 */
export function useNoteEditor(
  saveNote: (instanceId: TaskInstanceId, note: string | undefined) => Promise<boolean>,
  active: boolean,
): NoteEditor {
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [initialDraft, setInitialDraft] = useState('');
  const openRef = useRef<NoteTarget | null>(null);
  const draftRef = useRef('');
  /** Drafts whose save failed (or is still running), by instance id. */
  const failedRef = useRef<Partial<Record<string, string>>>({});
  const saveRef = useRef(saveNote);

  /**
   * purpose: Close the open editor and save its draft if it changed.
   * @return: (void)
   */
  const close = (): void => {
    const open = openRef.current;
    if (open === null) return;
    openRef.current = null;
    setOpenRowId(null);
    const draft = draftRef.current;
    if (!shouldSaveNote(draft, open.note)) {
      delete failedRef.current[open.instanceId];
      return;
    }
    failedRef.current[open.instanceId] = draft;
    void saveRef.current(open.instanceId, noteFromInput(draft)).then((saved) => {
      if (saved) delete failedRef.current[open.instanceId];
    });
  };
  const closeRef = useRef(close);

  useEffect(() => {
    saveRef.current = saveNote;
    closeRef.current = close;
  });

  /**
   * purpose: Open a row's editor (saving any other open one first), or close it if it is open.
   * @param target: (NoteTarget) The row, its task instance and its current note.
   * @return: (void)
   */
  const toggle = (target: NoteTarget): void => {
    const wasOpen = openRef.current?.rowId === target.rowId;
    close();
    if (wasOpen) return;
    const start = failedRef.current[target.instanceId] ?? target.note ?? '';
    draftRef.current = start;
    openRef.current = target;
    setInitialDraft(start);
    setOpenRowId(target.rowId);
  };

  /**
   * purpose: Remember the text typed in the editor.
   * @param text: (string) The field's text.
   * @return: (void)
   */
  const setDraft = (text: string): void => {
    draftRef.current = text;
  };

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') closeRef.current();
    });
    return () => {
      subscription.remove();
      closeRef.current();
    };
  }, []);

  useEffect(() => {
    if (!active) closeRef.current();
  }, [active]);

  return { openRowId, initialDraft, toggle, setDraft, close };
}
