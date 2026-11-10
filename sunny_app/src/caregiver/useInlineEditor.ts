// sunny_app/src/caregiver/useInlineEditor.ts
//
// Purpose: The autosaving inline editor of the caregiver About tab, the same interaction as the
// Home tab's note editor (useNoteEditor) generalized to any editable text (FieldTarget: an
// entry's name or details, a topic's wording or guidance, a fact). One text's editor is open at
// a time and there is no Save or Cancel: the draft is saved (when draftToSave says so) on every
// way the editor closes: tapping the text again, opening another text's editor, the field losing
// focus (the keyboard's Done, tapping outside, dragging the screen), the app going to the
// background and unmounting (useFlushOnLeave). settle(target) is for an action on the text's
// row that must not act on stale text (the fact's Confirm): it saves an open edit of that text, or
// reopens a kept draft of it, and says whether there was one.
//
// A draft that is not stored is kept (by field) until it is: one whose save failed, or one set
// aside by hold(rowKey) before a removal is confirmed (the removal's alert would otherwise blur
// the field and save it). Reopening the text shows the kept draft, and unsaved lists the rows
// that hold one (not while its save is running), so the row can say "Unsaved edit". forget(rowKey) drops a row's drafts
// once its removal succeeded. A save that succeeds forgets the draft only if it is still the text
// that was saved. close(key) acts only when that text is the open one, so a late blur from a
// field that is unmounting cannot close the next one. The typed text lives in a ref (the field
// is uncontrolled), so typing re-renders nothing; the actions keep their identity between renders.
//
// Last modified: 2026-11-09

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { draftToSave, fieldKey, fieldRowKey, type FieldTarget } from './aboutFormat';
import { useFlushOnLeave } from './useFlushOnLeave';

/** The open editor: its field key and the text the field starts with. */
export interface OpenField {
  key: string;
  /** The current text, or a kept draft. */
  initialDraft: string;
}

/** What useInlineEditor returns. */
export interface InlineEditor {
  /** The open editor; null when none is open. */
  open: OpenField | null;
  /** Rows (for example "entry:<id>") holding a draft that is not stored and not being saved. */
  unsaved: ReadonlySet<string>;
  /** Open the text's editor, or close (and save) it when it is the open one. */
  toggle: (target: FieldTarget) => void;
  /** Record the text typed in the open editor. */
  setDraft: (text: string) => void;
  /** Close the open editor, saving when needed; with a key, only if that text is the open one. */
  close: (key?: string) => void;
  /**
   * Save the open edit of this text, or reopen its kept draft; returns true when there was a
   * pending edit (so the caller must not act on the stored text).
   */
  settle: (target: FieldTarget) => boolean;
  /** Close the row's open editor without saving, keeping its draft for when it is reopened. */
  hold: (rowKey: string) => void;
  /** Drop every kept draft of the row (and close its editor without saving). */
  forget: (rowKey: string) => void;
}

/** A draft kept after its editor closed. */
interface KeptDraft {
  draft: string;
  rowKey: string;
  /** True while its save is running. */
  saving: boolean;
}

/** The unsaved set when nothing is kept. */
const NONE: ReadonlySet<string> = new Set();

/**
 * purpose: Manage the About tab's autosaving inline editor.
 * @param save: ((target, value) => Promise<boolean>) Saves the trimmed value (null clears an
 *        optional field); resolves true when saved. The latest function is always used.
 * @return: (InlineEditor) The open editor, the unsaved rows and the toggle, setDraft, close,
 *          settle, hold and forget actions.
 */
export function useInlineEditor(
  save: (target: FieldTarget, value: string | null) => Promise<boolean>,
): InlineEditor {
  const [open, setOpen] = useState<OpenField | null>(null);
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(NONE);
  /** The unsaved set last rendered, so refresh sets state only when it changes. */
  const unsavedRef = useRef<ReadonlySet<string>>(NONE);
  const targetRef = useRef<FieldTarget | null>(null);
  const draftRef = useRef('');
  /** Kept drafts, by field key. */
  const keptRef = useRef<Partial<Record<string, KeptDraft>>>({});
  const saveRef = useRef(save);

  useEffect(() => {
    saveRef.current = save;
  });

  /**
   * purpose: Recompute the unsaved rows from the kept drafts.
   * @return: (void)
   */
  const refresh = useCallback((): void => {
    const rows = new Set(
      Object.values(keptRef.current)
        .filter((kept): kept is KeptDraft => kept !== undefined && !kept.saving)
        .map((kept) => kept.rowKey),
    );
    const prev = unsavedRef.current;
    if (rows.size === prev.size && [...rows].every((row) => prev.has(row))) return;
    unsavedRef.current = rows;
    setUnsaved(rows);
  }, []);

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
  const closeAndSave = useCallback(
    (key?: string): boolean => {
      if (targetRef.current === null) return false;
      if (key !== undefined && fieldKey(targetRef.current) !== key) return false;
      const { target, draft } = detach()!;
      const openKey = fieldKey(target);
      const decision = draftToSave(draft, target);
      if (!decision.save) {
        delete keptRef.current[openKey];
        refresh();
        return false;
      }
      const kept: KeptDraft = { draft, rowKey: fieldRowKey(target), saving: true };
      keptRef.current[openKey] = kept;
      refresh();
      void saveRef.current(target, decision.value).then((saved) => {
        if (keptRef.current[openKey] !== kept) return;
        if (saved) delete keptRef.current[openKey];
        else kept.saving = false;
        refresh();
      });
      return true;
    },
    [detach, refresh],
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
      keptRef.current[fieldKey(target)] = { draft, rowKey, saving: false };
      refresh();
    },
    [detach, refresh],
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
      refresh();
    },
    [detach, refresh],
  );

  /**
   * purpose: Close the open editor (or, with a key, only that text's), saving when needed.
   * @param key: (string, optional) When given, close only if this is the open field.
   * @return: (void)
   */
  const close = useCallback(
    (key?: string): void => {
      closeAndSave(key);
    },
    [closeAndSave],
  );

  /**
   * purpose: Open a text's editor (saving any other open one first), or close it if it is open.
   *          A kept draft moves into the editor (and is kept again if closing does not store it).
   * @param target: (FieldTarget) The text and its current value.
   * @return: (void)
   */
  const toggle = useCallback(
    (target: FieldTarget): void => {
      const key = fieldKey(target);
      const wasOpen = targetRef.current !== null && fieldKey(targetRef.current) === key;
      closeAndSave();
      if (wasOpen) return;
      const kept = keptRef.current[key];
      const initialDraft = kept?.draft ?? target.current ?? '';
      if (kept !== undefined && !kept.saving) {
        delete keptRef.current[key];
        refresh();
      }
      draftRef.current = initialDraft;
      targetRef.current = target;
      setOpen({ key, initialDraft });
    },
    [closeAndSave, refresh],
  );

  /**
   * purpose: Settle a pending edit of a text: save it when open, reopen it when kept.
   * @param target: (FieldTarget) The text.
   * @return: (boolean) True when there was a pending edit; false when the stored text stands.
   */
  const settle = useCallback(
    (target: FieldTarget): boolean => {
      const key = fieldKey(target);
      if (closeAndSave(key)) return true;
      const kept = keptRef.current[key];
      if (kept === undefined || kept.saving) return false;
      toggle(target);
      return true;
    },
    [closeAndSave, toggle],
  );

  /**
   * purpose: Remember the text typed in the editor.
   * @param text: (string) The field's text.
   * @return: (void)
   */
  const setDraft = useCallback((text: string): void => {
    draftRef.current = text;
  }, []);

  useFlushOnLeave(close);

  return useMemo(
    () => ({ open, unsaved, toggle, setDraft, close, settle, hold, forget }),
    [open, unsaved, toggle, setDraft, close, settle, hold, forget],
  );
}
