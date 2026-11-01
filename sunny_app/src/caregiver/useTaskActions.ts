// sunny_app/src/caregiver/useTaskActions.ts
//
// Purpose: Hook behind the caregiver's actions on a task: "I'm on it" (claim), "Mark done"
// (confirm on the senior's behalf, immediately and without a note) and saving a task's note. It
// calls instances.claimTaskInstance, instances.confirmTaskInstance and instances.setTaskNote and
// tracks only what the day view cannot show: actions in
// flight and actions that failed (with the error message). A success needs no local state: the
// day view is a live subscription and carries the claim or the confirmation, so every caregiver
// sees it. One action runs per instance at a time, so a single map keyed by instance id holds
// the state. The state lives only while the screen is mounted. A Mark done that finds the task
// already finished by someone else shows "Already marked done." in the same slot.
//
// Last modified: 2026-11-01

import { useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';
import { alreadyDoneMessage } from './format';

/** An action that has not finished well: a claim or mark-done still running, or failed. */
export type TaskActionState =
  | { status: 'claiming' }
  | { status: 'marking' }
  | { status: 'saving' }
  | { status: 'error'; message: string };

/** What useTaskActions returns. */
export interface TaskActions {
  /** Pending or failed actions by task instance id; absent for everything else. */
  actions: Partial<Record<string, TaskActionState>>;
  claim: (instanceId: TaskInstanceId) => Promise<void>;
  /** Mark the task done as the signed-in caregiver, with no note. */
  markDone: (instanceId: TaskInstanceId) => Promise<void>;
  /** Save (or, with undefined, clear) the task's note; resolves true when it was saved. */
  saveNote: (instanceId: TaskInstanceId, note: string | undefined) => Promise<boolean>;
}

/**
 * purpose: Track and perform caregiver actions on tasks.
 * @param userId: (string | null) The signed-in caregiver's Clerk user id, to tell their own
 *        confirmation from one made first by someone else.
 * @return: (TaskActions) The in-flight and failed actions and the claim, markDone and saveNote
 *          functions.
 */
export function useTaskActions(userId: string | null): TaskActions {
  const [actions, setActions] = useState<Partial<Record<string, TaskActionState>>>({});

  /**
   * purpose: Record (or, with undefined, clear) one instance's action state.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @param state: (TaskActionState | undefined) The new state.
   * @return: (void)
   */
  const setAction = (instanceId: TaskInstanceId, state: TaskActionState | undefined): void => {
    setActions((prev) => ({ ...prev, [instanceId]: state }));
  };

  /**
   * purpose: Run one mutation for an instance, recording its progress. On success the state is
   *          cleared because the day view now shows the result.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @param working: (TaskActionState) The state to show while the call runs.
   * @param call: (() => Promise<unknown>) The mutation call.
   * @param notice: ((result: unknown) => string | null, optional) Maps a successful result to a
   *        calm message to show instead of clearing the state; null means plain success.
   * @return: (Promise<boolean>) Resolves once the outcome is recorded, true when the call
   *          succeeded with no notice; never rejects.
   */
  const run = async (
    instanceId: TaskInstanceId,
    working: TaskActionState,
    call: () => Promise<unknown>,
    notice?: (result: unknown) => string | null,
  ): Promise<boolean> => {
    setAction(instanceId, working);
    try {
      // Await the call first: an optional call on notice would skip evaluating its arguments
      // (and so the mutation) whenever no notice is given.
      const result = await call();
      const message = notice ? notice(result) : null;
      setAction(instanceId, message === null ? undefined : { status: 'error', message });
      return message === null;
    } catch (e) {
      setAction(instanceId, { status: 'error', message: toBackendError(e).message });
      return false;
    }
  };

  /**
   * purpose: Claim one alert as the signed-in caregiver.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @return: (Promise<void>) Resolves once the outcome is recorded; never rejects.
   */
  const claim = async (instanceId: TaskInstanceId): Promise<void> => {
    await run(instanceId, { status: 'claiming' }, () =>
      callMutation(api.instances.claimTaskInstance, { instanceId }),
    );
  };

  /**
   * purpose: Mark one task done as the signed-in caregiver, immediately and with no note (an
   *          existing note is kept by the server).
   * @param instanceId: (TaskInstanceId) The task instance.
   * @return: (Promise<void>) Resolves once the outcome is recorded; never rejects. When the
   *          task was already finished by someone else, the slot shows "Already marked done."
   */
  const markDone = async (instanceId: TaskInstanceId): Promise<void> => {
    await run(
      instanceId,
      { status: 'marking' },
      () => callMutation(api.instances.confirmTaskInstance, { instanceId, via: 'caregiver' }),
      (result) => alreadyDoneMessage((result as { confirmedBy?: string }).confirmedBy, userId),
    );
  };

  /**
   * purpose: Save or clear one task's note.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @param note: (string | undefined) The trimmed note; undefined clears it (dropped when the
   *        Convex client serializes the arguments, which the server reads as clear).
   * @return: (Promise<boolean>) True when saved; false when it failed (the slot shows why).
   */
  const saveNote = (instanceId: TaskInstanceId, note: string | undefined): Promise<boolean> =>
    run(instanceId, { status: 'saving' }, () =>
      callMutation(api.instances.setTaskNote, { instanceId, note }),
    );

  return { actions, claim, markDone, saveNote };
}
