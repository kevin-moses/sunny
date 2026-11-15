import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { draftToSave, fieldKey, fieldRowKey, type FieldTarget } from './aboutFormat';
import { useFlushOnLeave } from './useFlushOnLeave';

export interface OpenField {
  key: string;
  initialDraft: string;
}

export interface InlineEditor {
  open: OpenField | null;
  unsaved: ReadonlySet<string>;
  toggle: (target: FieldTarget) => void;
  setDraft: (text: string) => void;
  close: (key?: string) => void;
  settle: (target: FieldTarget) => boolean;
  hold: (rowKey: string) => void;
  forget: (rowKey: string) => void;
}

interface KeptDraft {
  draft: string;
  rowKey: string;
  saving: boolean;
}

const NONE: ReadonlySet<string> = new Set();

export function useInlineEditor(
  save: (target: FieldTarget, value: string | null) => Promise<boolean>,
): InlineEditor {
  const [open, setOpen] = useState<OpenField | null>(null);
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(NONE);
  const unsavedRef = useRef<ReadonlySet<string>>(NONE);
  const targetRef = useRef<FieldTarget | null>(null);
  const draftRef = useRef('');
  const keptRef = useRef<Partial<Record<string, KeptDraft>>>({});
  const saveRef = useRef(save);

  useEffect(() => {
    saveRef.current = save;
  });

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

  const detach = useCallback((): { target: FieldTarget; draft: string } | null => {
    const target = targetRef.current;
    if (target === null) return null;
    targetRef.current = null;
    setOpen(null);
    return { target, draft: draftRef.current };
  }, []);

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

  const hold = useCallback(
    (rowKey: string): void => {
      if (targetRef.current === null || fieldRowKey(targetRef.current) !== rowKey) return;
      const { target, draft } = detach()!;
      keptRef.current[fieldKey(target)] = { draft, rowKey, saving: false };
      refresh();
    },
    [detach, refresh],
  );

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

  const close = useCallback(
    (key?: string): void => {
      closeAndSave(key);
    },
    [closeAndSave],
  );

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

  const setDraft = useCallback((text: string): void => {
    draftRef.current = text;
  }, []);

  useFlushOnLeave(close);

  return useMemo(
    () => ({ open, unsaved, toggle, setDraft, close, settle, hold, forget }),
    [open, unsaved, toggle, setDraft, close, settle, hold, forget],
  );
}
