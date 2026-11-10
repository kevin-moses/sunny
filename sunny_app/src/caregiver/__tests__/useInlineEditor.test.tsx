// sunny_app/src/caregiver/__tests__/useInlineEditor.test.tsx
//
// Purpose: Tests for useInlineEditor, rendering the real hook with react-test-renderer: opening a
// text with its current value, saving on close only when draftToSave says so (unchanged and
// blank required texts are not saved, blank details clear) and close reporting whether it
// started a save, toggling the open text closes it, opening another text saves the first, a
// failed save's draft comes back on reopening, a successful save keeps a newer failed draft,
// close(key) acts only for the open text, hold closes a row's editor without saving but keeps
// the draft for reopening, forget drops a row's drafts (and closes its editor) without saving,
// unmounting saves an open draft, settle saves an open edit or reopens a kept one and reports
// whether one was pending, and the actions keep their identity between renders.
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

/**
 * purpose: Open a text and type a draft into it.
 * @param h: ({ get }) The rendered hook.
 * @param target: (FieldTarget) The text.
 * @param draft: (string) What is typed.
 * @return: (void)
 */
function type(h: { get: () => InlineEditor }, target: FieldTarget, draft: string): void {
  act(() => h.get().toggle(target));
  act(() => h.get().setDraft(draft));
}

/**
 * purpose: Close the editor inside act and say whether that started a save.
 * @param h: ({ get }) The rendered hook.
 * @param key: (string, optional) Close only this text.
 * @return: (boolean) Whether close called save.
 */
function close(h: { get: () => InlineEditor }, key?: string): boolean {
  const before = save.mock.calls.length;
  act(() => h.get().close(key));
  return save.mock.calls.length > before;
}

/**
 * purpose: Settle a text inside act and return what settle returned.
 * @param h: ({ get }) The rendered hook.
 * @param target: (FieldTarget) The text.
 * @return: (boolean) Whether there was a pending edit.
 */
function settle(h: { get: () => InlineEditor }, target: FieldTarget): boolean {
  let pending = false;
  act(() => {
    pending = h.get().settle(target);
  });
  return pending;
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

  it('saves the trimmed draft when the editor closes with a change, and says so', () => {
    const h = renderEditor();
    type(h, NAME, '  Sarah Lee ');
    expect(close(h)).toBe(true);
    expect(h.get().open).toBeNull();
    expect(save).toHaveBeenCalledWith(NAME, 'Sarah Lee');
  });

  it('does not save an unchanged draft or a blank required text, and says so', () => {
    const h = renderEditor();
    act(() => h.get().toggle(NAME));
    expect(close(h)).toBe(false);
    type(h, FACT, '   ');
    expect(close(h)).toBe(false);
    expect(close(h)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('clears details left blank', () => {
    const h = renderEditor();
    type(h, DETAILS, '');
    close(h);
    expect(save).toHaveBeenCalledWith(DETAILS, null);
  });

  it('toggling the open text closes and saves it', () => {
    const h = renderEditor();
    type(h, FACT, 'Likes green tea');
    act(() => h.get().toggle(FACT));
    expect(h.get().open).toBeNull();
    expect(save).toHaveBeenCalledWith(FACT, 'Likes green tea');
  });

  it('opening another text saves the first and opens the second', () => {
    const h = renderEditor();
    type(h, NAME, 'Sara');
    act(() => h.get().toggle(DETAILS));
    expect(save).toHaveBeenCalledWith(NAME, 'Sara');
    expect(h.get().open).toEqual({ key: 'entryDetails:e1', initialDraft: 'Daughter' });
  });

  it('brings back a draft whose save failed when the text is reopened', async () => {
    save.mockResolvedValue(false);
    const h = renderEditor();
    type(h, FACT, 'Likes coffee');
    await act(async () => {
      h.get().close();
    });
    act(() => h.get().toggle(FACT));
    expect(h.get().open?.initialDraft).toBe('Likes coffee');
  });

  it('a successful save keeps a newer failed draft of the same text', async () => {
    let resolveFirst!: (ok: boolean) => void;
    save.mockReturnValueOnce(new Promise((r) => (resolveFirst = r))).mockResolvedValueOnce(false);
    const h = renderEditor();
    type(h, FACT, 'First');
    close(h);
    type(h, FACT, 'Second');
    await act(async () => {
      h.get().close();
    });
    await act(async () => resolveFirst(true));
    act(() => h.get().toggle(FACT));
    expect(h.get().open?.initialDraft).toBe('Second');
  });

  it('close with a key acts only when that text is open', () => {
    const h = renderEditor();
    type(h, NAME, 'Sara');
    expect(close(h, 'fact:f1')).toBe(false);
    expect(h.get().open?.key).toBe('entryName:e1');
    expect(save).not.toHaveBeenCalled();
    expect(close(h, 'entryName:e1')).toBe(true);
    expect(h.get().open).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("hold closes the row's editor without saving and keeps the draft for reopening", () => {
    const h = renderEditor();
    type(h, DETAILS, 'Neighbor');
    act(() => h.get().hold('topic:e1'));
    expect(h.get().open?.key).toBe('entryDetails:e1');
    act(() => h.get().hold('entry:e1'));
    expect(h.get().open).toBeNull();
    expect(close(h, 'entryDetails:e1')).toBe(false);
    expect(save).not.toHaveBeenCalled();
    act(() => h.get().toggle(DETAILS));
    expect(h.get().open?.initialDraft).toBe('Neighbor');
  });

  it("forget drops the row's drafts and closes its editor without saving", async () => {
    save.mockResolvedValue(false);
    const h = renderEditor();
    type(h, NAME, 'Sara');
    await act(async () => {
      h.get().close();
    });
    type(h, DETAILS, 'Neighbor');
    save.mockClear();
    act(() => h.get().forget('entry:e1'));
    expect(h.get().open).toBeNull();
    expect(save).not.toHaveBeenCalled();
    act(() => h.get().toggle(NAME));
    expect(h.get().open?.initialDraft).toBe('Sarah');
  });

  it('saves an open draft when the screen unmounts', () => {
    const h = renderEditor();
    type(h, NAME, 'Sara');
    act(() => h.renderer.unmount());
    expect(save).toHaveBeenCalledWith(NAME, 'Sara');
  });

  it('lists a row as unsaved after a failed save, not while it runs, and not once reopened', async () => {
    let finish!: (ok: boolean) => void;
    save.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const h = renderEditor();
    type(h, FACT, 'Likes coffee');
    close(h);
    expect(h.get().unsaved.has('fact:f1')).toBe(false);
    await act(async () => finish(false));
    expect([...h.get().unsaved]).toEqual(['fact:f1']);
    act(() => h.get().toggle(FACT));
    expect(h.get().unsaved.size).toBe(0);
    expect(h.get().open?.initialDraft).toBe('Likes coffee');
  });

  it('lists a held row as unsaved until it is forgotten', () => {
    const h = renderEditor();
    type(h, NAME, 'Sara');
    act(() => h.get().hold('entry:e1'));
    expect([...h.get().unsaved]).toEqual(['entry:e1']);
    act(() => h.get().forget('entry:e1'));
    expect(h.get().unsaved.size).toBe(0);
  });

  it('settle saves an open changed edit and reports it pending', () => {
    const h = renderEditor();
    type(h, FACT, 'Likes green tea');
    expect(settle(h, FACT)).toBe(true);
    expect(save).toHaveBeenCalledWith(FACT, 'Likes green tea');
    expect(h.get().open).toBeNull();
  });

  it('settle closes an open unchanged edit and reports nothing pending', () => {
    const h = renderEditor();
    act(() => h.get().toggle(FACT));
    expect(settle(h, FACT)).toBe(false);
    expect(h.get().open).toBeNull();
    expect(settle(h, FACT)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('settle reopens a kept draft instead of letting the stored text stand', async () => {
    save.mockResolvedValue(false);
    const h = renderEditor();
    type(h, FACT, 'Likes coffee');
    await act(async () => h.get().close());
    save.mockClear();
    expect(settle(h, FACT)).toBe(true);
    expect(h.get().open).toEqual({ key: 'fact:f1', initialDraft: 'Likes coffee' });
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps its actions stable between renders', () => {
    const h = renderEditor();
    const first = h.get();
    act(() => h.get().toggle(NAME));
    const second = h.get();
    for (const key of ['toggle', 'setDraft', 'close', 'settle', 'hold', 'forget'] as const) {
      expect(second[key]).toBe(first[key]);
    }
  });
});
