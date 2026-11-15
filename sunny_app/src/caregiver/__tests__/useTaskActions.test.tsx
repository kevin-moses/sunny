import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BackendError, callMutation } from '../../backend/api';
import { ERROR_CLEAR_MS, useTaskActions, type TaskActions } from '../useTaskActions';

jest.mock('../../backend/convex', () => ({ convex: {} }));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const ID = 'inst1' as never;
const mounted: ReactTestRenderer[] = [];

function renderActions(): { get: () => TaskActions } {
  let current!: TaskActions;
  const Probe = (): null => {
    current = useTaskActions('user_1');
    return null;
  };
  act(() => {
    mounted.push(create(<Probe />));
  });
  return { get: () => current };
}

describe('useTaskActions', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
  });

  beforeEach(() => {
    mockCall.mockReset();
    mockCall.mockResolvedValue(null);
  });

  it('claim sends the claim mutation', async () => {
    const h = renderActions();
    await act(async () => {
      await h.get().claim(ID);
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    const [ref, args] = mockCall.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:claimTaskInstance');
    expect(args).toEqual({ instanceId: ID });
  });

  it('saveNote sends the note and resolves true', async () => {
    const h = renderActions();
    let ok = false;
    await act(async () => {
      ok = await h.get().saveNote(ID, 'hello');
    });
    expect(ok).toBe(true);
    expect(mockCall).toHaveBeenCalledTimes(1);
    const [ref, args] = mockCall.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:setTaskNote');
    expect(args).toEqual({ instanceId: ID, note: 'hello' });
  });

  it('markDone sends the confirm mutation as caregiver', async () => {
    mockCall.mockResolvedValue({ confirmedBy: 'user_1' });
    const h = renderActions();
    await act(async () => {
      await h.get().markDone(ID);
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    const [ref, args] = mockCall.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:confirmTaskInstance');
    expect(args).toEqual({ instanceId: ID, via: 'caregiver' });
  });

  it('markDone resolves true and clears the state when this caregiver marked it', async () => {
    mockCall.mockResolvedValue({ confirmedBy: 'user_1' });
    const h = renderActions();
    let ok = false;
    await act(async () => {
      ok = await h.get().markDone(ID);
    });
    expect(ok).toBe(true);
    expect(h.get().actions[ID as string]).toBeUndefined();
  });

  it('markDone resolves false with a calm message when someone else marked it first', async () => {
    mockCall.mockResolvedValue({ confirmedBy: 'user_2' });
    const h = renderActions();
    let ok = true;
    await act(async () => {
      ok = await h.get().markDone(ID);
    });
    expect(ok).toBe(false);
    expect(h.get().actions[ID as string]).toEqual({
      status: 'error',
      message: 'Already marked done.',
    });
  });

  it('markDone shows the marking state while the call runs', async () => {
    let finish!: (value: unknown) => void;
    mockCall.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const h = renderActions();
    let pending!: Promise<boolean>;
    act(() => {
      pending = h.get().markDone(ID);
    });
    expect(h.get().actions[ID as string]).toEqual({ status: 'marking' });
    await act(async () => {
      finish({ confirmedBy: 'user_1' });
      await pending;
    });
    expect(h.get().actions[ID as string]).toBeUndefined();
  });

  it('reopen sends reopenTaskInstance and clears the state on success', async () => {
    const h = renderActions();
    await act(async () => {
      await h.get().reopen(ID);
    });
    const [ref, args] = mockCall.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:reopenTaskInstance');
    expect(args).toEqual({ instanceId: ID });
    expect(h.get().actions[ID as string]).toBeUndefined();
  });

  it('reopen shows the reopening state while the call runs', async () => {
    let finish!: (value: unknown) => void;
    mockCall.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const h = renderActions();
    let pending!: Promise<void>;
    act(() => {
      pending = h.get().reopen(ID);
    });
    expect(h.get().actions[ID as string]).toEqual({ status: 'reopening' });
    await act(async () => {
      finish(null);
      await pending;
    });
    expect(h.get().actions[ID as string]).toBeUndefined();
  });

  it('reopen shows the server refusal in the task slot', async () => {
    mockCall.mockRejectedValue(new BackendError('This task is no longer on the schedule.', 400));
    const h = renderActions();
    await act(async () => {
      await h.get().reopen(ID);
    });
    expect(h.get().actions[ID as string]).toEqual({
      status: 'error',
      message: 'This task is no longer on the schedule.',
    });
  });

  it('undoMarkDone sends the undo mutation', async () => {
    const h = renderActions();
    await act(async () => {
      await h.get().undoMarkDone(ID);
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    const [ref, args] = mockCall.mock.calls[0];
    expect(getFunctionName(ref as never)).toBe('instances:undoResolve');
    expect(args).toEqual({ instanceId: ID });
    expect(h.get().actions[ID as string]).toBeUndefined();
  });

  it('undoMarkDone shows the refusal in the task slot', async () => {
    mockCall.mockRejectedValue(new Error('This can no longer be undone.'));
    const h = renderActions();
    await act(async () => {
      await h.get().undoMarkDone(ID);
    });
    expect(h.get().actions[ID as string]).toEqual({
      status: 'error',
      message: expect.any(String),
    });
  });

  it('keeps the action functions between renders', async () => {
    const h = renderActions();
    const first = h.get();
    await act(async () => {
      await h.get().claim(ID);
    });
    const second = h.get();
    expect(second.claim).toBe(first.claim);
    expect(second.markDone).toBe(first.markDone);
    expect(second.undoMarkDone).toBe(first.undoMarkDone);
    expect(second.saveNote).toBe(first.saveNote);
  });

  it('a rejected mutation sets the error state and saveNote resolves false', async () => {
    mockCall.mockRejectedValue(new Error('boom'));
    const h = renderActions();
    let ok = true;
    await act(async () => {
      ok = await h.get().saveNote(ID, 'x');
    });
    expect(ok).toBe(false);
    expect(h.get().actions[ID as string]).toEqual({
      status: 'error',
      message: expect.any(String),
    });
  });

  describe('overlapping calls and self-clearing errors', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('a note save finishing during Mark done does not clear the marking state', async () => {
      let finishSave!: (value: unknown) => void;
      let finishMark!: (value: unknown) => void;
      mockCall
        .mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (finishMark = resolve)));
      const h = renderActions();
      let save!: Promise<boolean>;
      let mark!: Promise<boolean>;
      act(() => {
        save = h.get().saveNote(ID, 'note');
      });
      act(() => {
        mark = h.get().markDone(ID);
      });
      expect(h.get().actions[ID as string]).toEqual({ status: 'marking' });
      await act(async () => {
        finishSave(null);
        await save;
      });
      expect(h.get().actions[ID as string]).toEqual({ status: 'marking' });
      await act(async () => {
        finishMark({ confirmedBy: 'user_1' });
        await mark;
      });
      expect(h.get().actions[ID as string]).toBeUndefined();
    });

    it('a failed save finishing during Mark done does not overwrite the marking state', async () => {
      let failSave!: (reason: unknown) => void;
      mockCall
        .mockReturnValueOnce(new Promise((_, reject) => (failSave = reject)))
        .mockReturnValueOnce(new Promise(() => {}));
      const h = renderActions();
      let save!: Promise<boolean>;
      act(() => {
        save = h.get().saveNote(ID, 'note');
      });
      act(() => {
        void h.get().markDone(ID);
      });
      await act(async () => {
        failSave(new Error('boom'));
        await save;
      });
      expect(h.get().actions[ID as string]).toEqual({ status: 'marking' });
    });

    it('an error message clears itself after five seconds', async () => {
      mockCall.mockRejectedValue(new Error('boom'));
      const h = renderActions();
      await act(async () => {
        await h.get().claim(ID);
      });
      expect(h.get().actions[ID as string]?.status).toBe('error');
      act(() => {
        jest.advanceTimersByTime(ERROR_CLEAR_MS - 1);
      });
      expect(h.get().actions[ID as string]?.status).toBe('error');
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(h.get().actions[ID as string]).toBeUndefined();
    });

    it('"Already marked done." clears itself after five seconds', async () => {
      mockCall.mockResolvedValue({ confirmedBy: 'user_2' });
      const h = renderActions();
      await act(async () => {
        await h.get().markDone(ID);
      });
      expect(h.get().actions[ID as string]).toEqual({
        status: 'error',
        message: 'Already marked done.',
      });
      act(() => {
        jest.advanceTimersByTime(ERROR_CLEAR_MS);
      });
      expect(h.get().actions[ID as string]).toBeUndefined();
    });

    it('the next action replaces an error and the old timer does not clear the new state', async () => {
      mockCall.mockRejectedValueOnce(new Error('boom'));
      const h = renderActions();
      await act(async () => {
        await h.get().claim(ID);
      });
      let finish!: (value: unknown) => void;
      mockCall.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      let pending!: Promise<boolean>;
      act(() => {
        pending = h.get().markDone(ID);
      });
      expect(h.get().actions[ID as string]).toEqual({ status: 'marking' });
      act(() => {
        jest.advanceTimersByTime(ERROR_CLEAR_MS);
      });
      expect(h.get().actions[ID as string]).toEqual({ status: 'marking' });
      await act(async () => {
        finish({ confirmedBy: 'user_1' });
        await pending;
      });
    });
  });
});
