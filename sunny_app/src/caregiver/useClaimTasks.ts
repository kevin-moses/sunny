// sunny_app/src/caregiver/useClaimTasks.ts
//
// Purpose: Hook behind the "I'm on it" button. It calls instances.claimTaskInstance and tracks
// only what the day view cannot show: claims in flight and claims that failed (with the error
// message). A successful claim needs no local state: the day view is a live subscription and
// carries claimedBy and claimedByName, so every caregiver sees who is on it. The state lives
// only while the screen is mounted.
//
// Last modified: 2026-10-31

import { useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';

/** A claim that has not finished well: still running, or failed with a message. */
export type ClaimState = { status: 'claiming' } | { status: 'error'; message: string };

/** What useClaimTasks returns. */
export interface ClaimTasks {
  /** Pending or failed claims by task instance id; absent for everything else. */
  claims: Partial<Record<string, ClaimState>>;
  claim: (instanceId: TaskInstanceId) => Promise<void>;
}

/**
 * purpose: Track and perform claims of alert tasks.
 * @return: (ClaimTasks) The in-flight and failed claims and the claim function.
 */
export function useClaimTasks(): ClaimTasks {
  const [claims, setClaims] = useState<Partial<Record<string, ClaimState>>>({});

  /**
   * purpose: Record (or, with undefined, clear) one instance's claim state.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @param state: (ClaimState | undefined) The new state.
   * @return: (void)
   */
  const setClaim = (instanceId: TaskInstanceId, state: ClaimState | undefined): void => {
    setClaims((prev) => ({ ...prev, [instanceId]: state }));
  };

  /**
   * purpose: Claim one alert as the signed-in caregiver. On success the state is cleared
   *          because the day view now shows the claim.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @return: (Promise<void>) Resolves once the outcome is recorded; never rejects.
   */
  const claim = async (instanceId: TaskInstanceId): Promise<void> => {
    setClaim(instanceId, { status: 'claiming' });
    try {
      await callMutation(api.instances.claimTaskInstance, { instanceId });
      setClaim(instanceId, undefined);
    } catch (e) {
      setClaim(instanceId, { status: 'error', message: toBackendError(e).message });
    }
  };

  return { claims, claim };
}
