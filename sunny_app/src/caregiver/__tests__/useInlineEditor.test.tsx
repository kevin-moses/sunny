// sunny_app/src/caregiver/__tests__/useInlineEditor.test.tsx
//
// Purpose: Tests for useInlineEditor, rendering the real hook with react-test-renderer: opening a
// text with its current value, saving on close only when draftToSave says so (unchanged and
// blank required texts are not saved, blank details clear), toggling the open text closes it,
// opening another text saves the first, a failed save's draft comes back on reopening, a
// successful save keeps a newer failed draft, close(key) acts only for the open text, unmounting
// saves an open draft, and the actions keep their identity between renders.
//
// Last modified: 2026-11-09

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { FieldTarget } from '../aboutFormat';
import { useInlineEditor, type InlineEditor } from '../useInlineEditor';

const save = jest.fn<(target: FieldTarget, value: string | null) => Promise<boolean>>();
const NAME: FieldTarget = { kind: 'entryName', id: 'e1' as never, current: 'Sarah' };
const DETAILS: FieldTarget = { kind: 'entryDetails', id: 'e1' as never, current: 'Daughter' };
const FACT: FieldTarget = { kind: 'fact', id: 'f1' as never, current: 'Likes tea' };

/**
 * purpose: Render the real hook and expose its latest return value.
 * @return: (object) A getter for the current InlineEditor and the renderer.
 */
function renderEditor(): { get: () => InlineEditor; renderer: ReactTestRenderer } {
  let current!: InlineEditor;
  const Probe = (): null => {
    current = useInlineEditor(save);
    return null;
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe />);
  });
  return { get: () => current, renderer };
}

describe('useInlineEditor', () => {
  beforeEach(() => {
    save.mockReset().mockResolvedValue(true);
  });

  it('opens a text with its current value as the starting draft', () => {
    const h = renderEditor();
    act(() => h.get().toggle(NAME));
    expect(h.get().open).toEqual({ key: 'entryName:e1', initialDraft: 'Sarah' });
  });

  it('saves the trimmed draft when the editor closes with a change', () => {
    const h = renderEditor();
    act(() => h.get().toggle(NAME));
    act(() => h.get().setDraft('  Sarah Lee '));
    act(() => h.get().close());
    expect(h.get().open).toBeNull();
    expect(save).toHaveBeenCalledWith(NAME, 'Sarah Lee');
  });

  it('does not save an unchanged draft or a blank required text', () => {
    const h = renderEditor();
    act(() => h.get().toggle(NAME));
    act(() => h.get().close());
    act(() => h.get().toggle(FACT));
    act(() => h.get().setDraft('   '));
    act(() => h.get().close());
    expect(save).not.toHaveBeenCalled();
  });

  it('clears details left blank', () => {
    const h = renderEditor();
    act(() => h.get().toggle(DETAILS));
    act(() => h.get().setDraft(''));
    act(() => h.get().close());
    expect(save).toHaveBeenCalledWith(DETAILS, null);
  });

  it('toggling the open text closes and saves it', () => {
    const h = renderEditor();
    act(() => h.get().toggle(FACT));
    act(() => h.get().setDraft('Likes green tea'));
    act(() => h.get().toggle(FACT));
    expect(h.get().open).toBeNull();
    expect(save).toHaveBeenCalledWith(FACT, 'Likes green tea');
  });

  it('opening another text saves the first and opens the second', () => {
    const h = renderEditor();
    act(() => h.get().toggle(NAME));
    act(() => h.get().setDraft('Sara'));
    act(() => h.get().toggle(DETAILS));
    expect(save).toHaveBeenCalledWith(NAME, 'Sara');
    expect(h.get().open).toEqual({ key: 'entryDetails:e1', initialDraft: 'Daughter' });
  });

  it('brings back a draft whose save failed when the text is reopened', async () => {
    save.mockResolvedValue(false);
    const h = renderEditor();
    act(() => h.get().toggle(FACT));
    act(() => h.get().setDraft('Likes coffee'));
    await act(async () => h.get().close());
    act(() => h.get().toggle(FACT));
    expect(h.get().open?.initialDraft).toBe('Likes coffee');
  });

  it('a successful save keeps a newer failed draft of the same text', async () => {
    let resolveFirst!: (ok: boolean) => void;
    save.mockReturnValueOnce(new Promise((r) => (resolveFirst = r))).mockResolvedValueOnce(false);
    const h = renderEditor();
    act(() => h.get().toggle(FACT));
    act(() => h.get().setDraft('First'));
    act(() => h.get().close());
    act(() => h.get().toggle(FACT));
    act(() => h.get().setDraft('Second'));
    await act(async () => h.get().close());
    await act(async () => resolveFirst(true));
    act(() => h.get().toggle(FACT));
    expect(h.get().open?.initialDraft).toBe('Second');
  });

  it('close with a key acts only when that text is open', () => {
    const h = renderEditor();
    act(() => h.get().toggle(NAME));
    act(() => h.get().setDraft('Sara'));
    act(() => h.get().close('fact:f1'));
    expect(h.get().open?.key).toBe('entryName:e1');
    expect(save).not.toHaveBeenCalled();
    act(() => h.get().close('entryName:e1'));
    expect(h.get().open).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves an open draft when the screen unmounts', () => {
    const h = renderEditor();
    act(() => h.get().toggle(NAME));
    act(() => h.get().setDraft('Sara'));
    act(() => h.renderer.unmount());
    expect(save).toHaveBeenCalledWith(NAME, 'Sara');
  });

  it('keeps toggle, setDraft and close stable between renders', () => {
    const h = renderEditor();
    const first = h.get();
    act(() => h.get().toggle(NAME));
    const second = h.get();
    expect(second.toggle).toBe(first.toggle);
    expect(second.setDraft).toBe(first.setDraft);
    expect(second.close).toBe(first.close);
  });
});
