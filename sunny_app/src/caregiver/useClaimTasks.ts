// sunny_app/src/caregiver/useClaimTasks.ts
//
// Purpose: Hook behind the "I'm on it" button. It calls instances.claimTaskInstance and keeps a
// per-instance state locally (claiming, claimed, or an error message), because the day view
// carries no claimedBy field. The state lives only while the screen is mounted.
//
// Last modified: 2026-10-30

import { useCallback, useState } from 'react';

import { callMutation, toBackendError } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';

/** Where one alert's claim stands. */
export type ClaimState =
  { status: 'claiming' } | { status: 'claimed' } | { status: 'error'; message: string };

/** What useClaimTasks returns. */
export interface ClaimTasks {
  /** Claim state by task instance id; absent until the caregiver presses the button. */
  claims: Partial<Record<string, ClaimState>>;
  claim: (instanceId: TaskInstanceId) => Promise<void>;
}

/**
 * purpose: Track and perform claims of alert tasks.
 * @return: (ClaimTasks) The per-instance claim states and the claim function.
 */
export function useClaimTasks(): ClaimTasks {
  const [claims, setClaims] = useState<Partial<Record<string, ClaimState>>>({});

  /**
   * purpose: Claim one alert as the signed-in caregiver and record the outcome.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @return: (Promise<void>) Resolves once the outcome is recorded; never rejects.
   */
  const claim = useCallback(async (instanceId: TaskInstanceId): Promise<void> => {
    setClaims((prev) => ({ ...prev, [instanceId]: { status: 'claiming' } }));
    try {
      await callMutation(api.instances.claimTaskInstance, { instanceId });
      setClaims((prev) => ({ ...prev, [instanceId]: { status: 'claimed' } }));
    } catch (e) {
      const message = toBackendError(e).message;
      setClaims((prev) => ({ ...prev, [instanceId]: { status: 'error', message } }));
    }
  }, []);

  return { claims, claim };
}
