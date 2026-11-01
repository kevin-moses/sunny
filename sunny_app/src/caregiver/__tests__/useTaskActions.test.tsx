// sunny_app/src/caregiver/__tests__/useTaskActions.test.tsx
//
// Purpose: Regression tests for useTaskActions, rendering the real hook with react-test-renderer
// and a mocked callMutation. Guards the bug where run() skipped the mutation entirely when no
// notice callback was given (claim and saveNote), and checks the error state on a failed call.
//
// Last modified: 2026-11-01

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import { useTaskActions, type TaskActions } from '../useTaskActions';

jest.mock('../../backend/convex', () => ({ convex: {} }));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const ID = 'inst1' as never;

/**
 * purpose: Render the real hook and expose its latest return value.
 * @return: (object) A getter for the current TaskActions.
 */
function renderActions(): { get: () => TaskActions } {
  let current!: TaskActions;
  const Probe = (): null => {
    current = useTaskActions('user_1');
    return null;
  };
  act(() => {
    create(<Probe />);
  });
  return { get: () => current };
}

describe('useTaskActions', () => {
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
});
