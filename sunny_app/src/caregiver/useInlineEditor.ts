// sunny_app/src/caregiver/useInlineEditor.ts
//
// Purpose: The autosaving inline editor of the caregiver About tab, the same interaction as the
// Home tab's note editor (useNoteEditor) generalized to any editable text (FieldTarget: an
// entry's name or details, a topic's wording or guidance, a fact). One text's editor is open at
// a time and there is no Save or Cancel: the draft is saved (when draftToSave says so) on every
// way the editor closes: tapping the text again, opening another text's editor, the field losing
// focus (the keyboard's Done, tapping outside, dragging the screen), the app going to the
// background and unmounting (useFlushOnLeave). close reports whether it started a save, so a
// Confirm tapped while the fact is being corrected saves the correction (which confirms it)
// instead of confirming the old text. A save that fails keeps its draft so reopening the text
// shows it (and closing it retries); a save that succeeds forgets the draft only if it is still
// the text that was saved. Before a row is removed, hold(rowKey) closes its editor without saving
// but keeps the draft (shown again if the removal is cancelled and the text reopened), and
// forget(rowKey) drops the row's kept drafts once the removal is confirmed, so no save is aimed
// at a deleted row. close(key) acts only when that text is the open one, so a late blur from a
// field that is unmounting cannot close the next one. The typed text lives in a ref (the field is
// uncontrolled), so typing re-renders nothing; the actions keep their identity between renders.
//
// Last modified: 2026-11-09

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { draftToSave, fieldKey, fieldRowKey, type FieldTarget } from './aboutFormat';
import { useFlushOnLeave } from './useFlushOnLeave';

/** The open editor: its field key and the text the field starts with. */
export interface OpenField {
  key: string;
  /** The current text, or a draft that failed to save (or was held). */
  initialDraft: string;
}

/** What useInlineEditor returns. */
export interface InlineEditor {
  /** The open editor; null when none is open. */
  open: OpenField | null;
  /** Open the text's editor, or close (and save) it when it is the open one. */
  toggle: (target: FieldTarget) => void;
  /** Record the text typed in the open editor. */
  setDraft: (text: string) => void;
  /**
   * Close the open editor, saving when needed; with a key, only if that text is the open one.
   * Returns true when it started a save.
   */
  close: (key?: string) => boolean;
  /** Close the row's open editor without saving, keeping its draft for when it is reopened. */
  hold: (rowKey: string) => void;
  /** Drop every kept draft of the row (and close its editor without saving). */
  forget: (rowKey: string) => void;
}

/** A draft kept after its editor closed (its save failed or is running, or it was held). */
interface KeptDraft {
  draft: string;
  rowKey: string;
}

/**
 * purpose: Manage the About tab's autosaving inline editor.
 * @param save: ((target, value) => Promise<boolean>) Saves the trimmed value (null clears an
 *        optional field); resolves true when saved. The latest function is always used.
 * @return: (InlineEditor) The open editor and the toggle, setDraft, close, hold and forget
 *          actions.
 */
export function useInlineEditor(
  save: (target: FieldTarget, value: string | null) => Promise<boolean>,
): InlineEditor {
  const [open, setOpen] = useState<OpenField | null>(null);
  const targetRef = useRef<FieldTarget | null>(null);
  const draftRef = useRef('');
  /** Drafts kept after their editor closed, by field key. */
  const keptRef = useRef<Partial<Record<string, KeptDraft>>>({});
  const saveRef = useRef(save);

  useEffect(() => {
    saveRef.current = save;
  });

  /**
   * purpose: Close the open editor without saving and return what it held.
   * @return: ({ target, draft } | null) The closed editor's text and draft, or null when none
   *          was open.
   */
  const detach = useCallback((): { target: FieldTarget; draft: string } | null => {
    const target = targetRef.current;
    if (target === null) return null;
    targetRef.current = null;
    setOpen(null);
    return { target, draft: draftRef.current };
  }, []);

  /**
   * purpose: Close the open editor and save its draft when draftToSave says so.
   * @param key: (string, optional) When given, close only if this is the open field.
   * @return: (boolean) True when a save was started.
   */
  const close = useCallback(
    (key?: string): boolean => {
      if (targetRef.current === null) return false;
      if (key !== undefined && fieldKey(targetRef.current) !== key) return false;
      const { target, draft } = detach()!;
      const openKey = fieldKey(target);
      const decision = draftToSave(draft, target);
      if (!decision.save) {
        delete keptRef.current[openKey];
        return false;
      }
      keptRef.current[openKey] = { draft, rowKey: fieldRowKey(target) };
      void saveRef.current(target, decision.value).then((saved) => {
        if (saved && keptRef.current[openKey]?.draft === draft) delete keptRef.current[openKey];
      });
      return true;
    },
    [detach],
  );

  /**
   * purpose: Close the row's open editor without saving, keeping its draft.
   * @param rowKey: (string) The row, for example "entry:<id>".
   * @return: (void)
   */
  const hold = useCallback(
    (rowKey: string): void => {
      if (targetRef.current === null || fieldRowKey(targetRef.current) !== rowKey) return;
      const { target, draft } = detach()!;
      keptRef.current[fieldKey(target)] = { draft, rowKey };
    },
    [detach],
  );

  /**
   * purpose: Drop the row's kept drafts and close its open editor without saving.
   * @param rowKey: (string) The row, for example "entry:<id>".
   * @return: (void)
   */
  const forget = useCallback(
    (rowKey: string): void => {
      if (targetRef.current !== null && fieldRowKey(targetRef.current) === rowKey) detach();
      for (const [key, kept] of Object.entries(keptRef.current)) {
        if (kept?.rowKey === rowKey) delete keptRef.current[key];
      }
    },
    [detach],
  );

  /**
   * purpose: Close whatever editor is open (used when the app leaves the screen).
   * @return: (void)
   */
  const flush = useCallback((): void => {
    close();
  }, [close]);

  /**
   * purpose: Open a text's editor (saving any other open one first), or close it if it is open.
   * @param target: (FieldTarget) The text and its current value.
   * @return: (void)
   */
  const toggle = useCallback(
    (target: FieldTarget): void => {
      const key = fieldKey(target);
      const wasOpen = targetRef.current !== null && fieldKey(targetRef.current) === key;
      close();
      if (wasOpen) return;
      const initialDraft = keptRef.current[key]?.draft ?? target.current ?? '';
      draftRef.current = initialDraft;
      targetRef.current = target;
      setOpen({ key, initialDraft });
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

  return useMemo(
    () => ({ open, toggle, setDraft, close, hold, forget }),
    [open, toggle, setDraft, close, hold, forget],
  );
}
