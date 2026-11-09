// sunny_app/src/caregiver/useInlineEditor.ts
//
// Purpose: The autosaving inline editor of the caregiver About tab, the same interaction as the
// Home tab's note editor (useNoteEditor) generalized to any editable text (FieldTarget: an
// entry's name or details, a topic's wording or guidance, a fact). One text's editor is open at
// a time and there is no Save or Cancel: the draft is saved (when draftToSave says so) on every
// way the editor closes: tapping the text again, opening another text's editor, the field losing
// focus (the keyboard's Done, tapping outside, dragging the screen), the app going to the
// background and unmounting (useFlushOnLeave). A save that fails keeps its draft so reopening
// the text shows it (and closing it retries); a save that succeeds forgets the draft only if it
// is still the text that was saved. close(key) acts only when that text is the open one, so a
// late blur from a field that is unmounting cannot close the next one. The typed text lives in
// a ref (the field is uncontrolled), so typing re-renders nothing; toggle, setDraft and close
// keep their identity between renders.
//
// Last modified: 2026-11-09

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { draftToSave, fieldKey, type FieldTarget } from './aboutFormat';
import { useFlushOnLeave } from './useFlushOnLeave';

/** The open editor: its field key and the text the field starts with. */
export interface OpenField {
  key: string;
  /** The current text, or a draft that failed to save. */
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
  /** Close the open editor, saving when needed; with a key, only if that text is the open one. */
  close: (key?: string) => void;
}

/**
 * purpose: Manage the About tab's autosaving inline editor.
 * @param save: ((target, value) => Promise<boolean>) Saves the trimmed value (null clears an
 *        optional field); resolves true when saved. The latest function is always used.
 * @return: (InlineEditor) The open editor and the toggle, setDraft and close actions.
 */
export function useInlineEditor(
  save: (target: FieldTarget, value: string | null) => Promise<boolean>,
): InlineEditor {
  const [open, setOpen] = useState<OpenField | null>(null);
  const targetRef = useRef<FieldTarget | null>(null);
  const draftRef = useRef('');
  /** Drafts whose save failed (or is still running), by field key. */
  const failedRef = useRef<Partial<Record<string, string>>>({});
  const saveRef = useRef(save);

  useEffect(() => {
    saveRef.current = save;
  });

  /**
   * purpose: Close the open editor and save its draft when draftToSave says so.
   * @param key: (string, optional) When given, close only if this is the open field.
   * @return: (void)
   */
  const close = useCallback((key?: string): void => {
    const target = targetRef.current;
    if (target === null) return;
    const openKey = fieldKey(target);
    if (key !== undefined && openKey !== key) return;
    targetRef.current = null;
    setOpen(null);
    const draft = draftRef.current;
    const decision = draftToSave(draft, target);
    if (!decision.save) {
      delete failedRef.current[openKey];
      return;
    }
    failedRef.current[openKey] = draft;
    void saveRef.current(target, decision.value).then((saved) => {
      if (saved && failedRef.current[openKey] === draft) delete failedRef.current[openKey];
    });
  }, []);

  /**
   * purpose: Close whatever editor is open (used when the app leaves the screen).
   * @return: (void)
   */
  const flush = useCallback((): void => close(), [close]);

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
      const initialDraft = failedRef.current[key] ?? target.current ?? '';
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

  return useMemo(() => ({ open, toggle, setDraft, close }), [open, toggle, setDraft, close]);
}
