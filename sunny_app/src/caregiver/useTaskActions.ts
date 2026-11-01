// sunny_app/src/caregiver/useTaskActions.ts
//
// Purpose: Hook behind the caregiver's two actions on a task: "I'm on it" (claim) and "Mark done"
// (confirm on the senior's behalf, with an optional note). It calls instances.claimTaskInstance
// and instances.confirmTaskInstance and tracks only what the day view cannot show: actions in
// flight and actions that failed (with the error message). A success needs no local state: the
// day view is a live subscription and carries the claim or the confirmation, so every caregiver
// sees it. One action runs per instance at a time, so a single map keyed by instance id holds
// the state. The state lives only while the screen is mounted.
//
// Last modified: 2026-11-01

import { useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';

/** An action that has not finished well: a claim or mark-done still running, or failed. */
export type TaskActionState =
  { status: 'claiming' } | { status: 'marking' } | { status: 'error'; message: string };

/** What useTaskActions returns. */
export interface TaskActions {
  /** Pending or failed actions by task instance id; absent for everything else. */
  actions: Partial<Record<string, TaskActionState>>;
  claim: (instanceId: TaskInstanceId) => Promise<void>;
  /** Mark the task done as the signed-in caregiver; an absent note is not sent. */
  markDone: (instanceId: TaskInstanceId, note?: string) => Promise<void>;
}

/**
 * purpose: Track and perform caregiver actions on tasks.
 * @return: (TaskActions) The in-flight and failed actions and the claim and markDone functions.
 */
export function useTaskActions(): TaskActions {
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
   * @return: (Promise<void>) Resolves once the outcome is recorded; never rejects.
   */
  const run = async (
    instanceId: TaskInstanceId,
    working: TaskActionState,
    call: () => Promise<unknown>,
  ): Promise<void> => {
    setAction(instanceId, working);
    try {
      await call();
      setAction(instanceId, undefined);
    } catch (e) {
      setAction(instanceId, { status: 'error', message: toBackendError(e).message });
    }
  };

  /**
   * purpose: Claim one alert as the signed-in caregiver.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @return: (Promise<void>) Resolves once the outcome is recorded; never rejects.
   */
  const claim = (instanceId: TaskInstanceId): Promise<void> =>
    run(instanceId, { status: 'claiming' }, () =>
      callMutation(api.instances.claimTaskInstance, { instanceId }),
    );

  /**
   * purpose: Mark one task done as the signed-in caregiver.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @param note: (string | undefined) Note for the family; omitted from the call when absent.
   * @return: (Promise<void>) Resolves once the outcome is recorded; never rejects.
   */
  const markDone = (instanceId: TaskInstanceId, note?: string): Promise<void> =>
    run(instanceId, { status: 'marking' }, () =>
      callMutation(api.instances.confirmTaskInstance, {
        instanceId,
        via: 'caregiver',
        ...(note === undefined ? {} : { note }),
      }),
    );

  return { actions, claim, markDone };
}
