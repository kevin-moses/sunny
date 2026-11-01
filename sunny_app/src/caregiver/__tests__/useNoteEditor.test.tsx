// sunny_app/src/caregiver/__tests__/useNoteEditor.test.tsx
//
// Purpose: Tests for useNoteEditor, rendering the real hook with react-test-renderer: opening a
// row, saving on close only when the trimmed draft changed (blank clears), toggling the open row
// closes it, opening another row saves the first, a failed save's draft comes back when the row
// is reopened, unmounting saves an open draft, and toggle, setDraft and close keep their
// identity between renders.
//
// Last modified: 2026-11-01

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { TaskInstanceId } from '../../backend/convexApi';
import { useNoteEditor, type NoteEditor } from '../useNoteEditor';

const save = jest.fn<(id: TaskInstanceId, note: string | undefined) => Promise<boolean>>();
const A = { rowId: 'row-a', instanceId: 'a' as TaskInstanceId, note: 'Old' };
const B = { rowId: 'row-b', instanceId: 'b' as TaskInstanceId, note: null };

/**
 * purpose: Render the real hook and expose its latest return value.
 * @return: (object) A getter for the current NoteEditor and the renderer.
 */
function renderEditor(): { get: () => NoteEditor; renderer: ReactTestRenderer } {
  let current!: NoteEditor;
  const Probe = (): null => {
    current = useNoteEditor(save);
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe />);
  });
  return { get: () => current, renderer };
}

describe('useNoteEditor', () => {
  beforeEach(() => {
    save.mockReset().mockResolvedValue(true);
  });

  it('opens a row with its current note as the starting text', () => {
    const h = renderEditor();
    act(() => h.get().toggle(A));
    expect(h.get().open).toEqual({ rowId: 'row-a', initialDraft: 'Old' });
  });

  it('closing with an edited draft saves the trimmed text', async () => {
    const h = renderEditor();
    act(() => h.get().toggle(A));
    act(() => h.get().setDraft('  New note '));
    await act(async () => h.get().close());
    expect(save).toHaveBeenCalledWith('a', 'New note');
    expect(h.get().open).toBeNull();
  });

  it('closing with a blank draft over a note clears it', async () => {
    const h = renderEditor();
    act(() => h.get().toggle(A));
    act(() => h.get().setDraft('   '));
    await act(async () => h.get().close());
    expect(save).toHaveBeenCalledWith('a', undefined);
  });

  it('closing with an unchanged draft saves nothing', () => {
    const h = renderEditor();
    act(() => h.get().toggle(A));
    act(() => h.get().setDraft(' Old '));
    act(() => h.get().close());
    expect(save).not.toHaveBeenCalled();
  });

  it('closing when nothing is open does nothing', () => {
    const h = renderEditor();
    act(() => h.get().close());
    expect(save).not.toHaveBeenCalled();
  });

  it('toggling the open row closes and saves it', async () => {
    const h = renderEditor();
    act(() => h.get().toggle(A));
    act(() => h.get().setDraft('Changed'));
    await act(async () => h.get().toggle(A));
    expect(save).toHaveBeenCalledWith('a', 'Changed');
    expect(h.get().open).toBeNull();
  });

  it('opening another row saves the first and opens the second', async () => {
    const h = renderEditor();
    act(() => h.get().toggle(A));
    act(() => h.get().setDraft('Changed'));
    await act(async () => h.get().toggle(B));
    expect(save).toHaveBeenCalledWith('a', 'Changed');
    expect(h.get().open).toEqual({ rowId: 'row-b', initialDraft: '' });
  });

  it('brings back a draft whose save failed when the row is reopened', async () => {
    save.mockResolvedValue(false);
    const h = renderEditor();
    act(() => h.get().toggle(A));
    act(() => h.get().setDraft('Unsaved'));
    await act(async () => h.get().close());
    act(() => h.get().toggle(A));
    expect(h.get().open?.initialDraft).toBe('Unsaved');
  });

  it('saves an open draft when the screen unmounts', () => {
    const h = renderEditor();
    act(() => h.get().toggle(A));
    act(() => h.get().setDraft('Last words'));
    act(() => h.renderer.unmount());
    expect(save).toHaveBeenCalledWith('a', 'Last words');
  });

  it('keeps toggle, setDraft and close stable between renders', () => {
    const h = renderEditor();
    const { toggle, setDraft, close } = h.get();
    act(() => h.get().toggle(A));
    expect(h.get().toggle).toBe(toggle);
    expect(h.get().setDraft).toBe(setDraft);
    expect(h.get().close).toBe(close);
  });
});
