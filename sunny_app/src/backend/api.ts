// sunny_app/src/backend/api.ts
//
// Purpose: Typed calls to Sunny's Convex backend as the signed-in device (callMutation,
// callAction) and the error they throw. Every failure is a BackendError with a message safe to
// show and an HTTP-like status so callers can branch on it (for example 404 for a stale task
// instance). The backend throws ConvexError with data { code, message }; the code maps to a
// status below (the table is typed by the backend's AppErrorCode, so a new code is a compile
// error). Anything else (network failure, an unexpected server error, whose details Convex
// hides) is status 0 with a generic or offline message.
//
// Last modified: 2026-10-29

import { ConvexError } from 'convex/values';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';

import type { AppErrorCode, AppErrorData } from '../../../sunny_backend/convex/lib/errors';
import { convex } from './convex';

/** An error from the Sunny backend, with a message safe to show and a status. */
export class BackendError extends Error {
  readonly status: number;

  /**
   * purpose: Create a backend error.
   * @param message: (string) Message safe to show to the user.
   * @param status: (number) HTTP-like status; 0 when there is no meaningful status.
   */
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
  }
}

/** Status for each application error code the backend throws. */
const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  limit: 429,
};

/** Message used when a failure carries nothing safe to show. */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/** Message used for unauthenticated and forbidden errors instead of the server's text. */
export const NOT_CONNECTED_MESSAGE = 'This device is no longer connected to a family.';

/**
 * Messages of known connection failures: React Native's fetch (whatwg-fetch) rejects with
 * "Network request failed" / "Network request timed out", browsers with "Failed to fetch", and
 * the Convex client fails an action in flight when its socket drops with the third one.
 */
const NETWORK_MESSAGES = [
  'Network request failed',
  'Network request timed out',
  'Failed to fetch',
  'Connection lost while action was in flight',
];

/** Message used when the request never reached the backend. */
export const OFFLINE_ERROR_MESSAGE = 'Could not reach Sunny. Check the internet connection.';

/**
 * purpose: Convert anything thrown by a Convex call into a BackendError.
 * @param error: (unknown) The thrown value.
 * @return: (BackendError) The same error when it already is one; for a ConvexError the
 *          status of its code (0 for an unknown code) with the server's message, except that
 *          unauthenticated and forbidden show NOT_CONNECTED_MESSAGE; otherwise status 0 with
 *          the offline message for a known connection failure or the generic message.
 */
export function toBackendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof ConvexError) {
    const data = error.data as Partial<AppErrorData> | undefined;
    const known = typeof data?.code === 'string' && data.code in STATUS_BY_CODE;
    const status = known ? STATUS_BY_CODE[data.code as AppErrorCode] : 0;
    const calm = status === 401 || status === 403;
    return new BackendError(
      calm ? NOT_CONNECTED_MESSAGE : data?.message || GENERIC_ERROR_MESSAGE,
      status,
    );
  }
  if (error instanceof Error && NETWORK_MESSAGES.some((m) => error.message.includes(m))) {
    return new BackendError(OFFLINE_ERROR_MESSAGE, 0);
  }
  return new BackendError(GENERIC_ERROR_MESSAGE, 0);
}

/**
 * purpose: Run a mutation as this device.
 * @param reference: (FunctionReference<'mutation'>) The mutation, for example
 *        api.households.registerPushToken.
 * @param args: (FunctionArgs) The mutation's arguments.
 * @return: (Promise<FunctionReturnType>) The mutation's result.
 * @raises: BackendError when the call fails.
 */
export async function callMutation<M extends FunctionReference<'mutation'>>(
  reference: M,
  args: FunctionArgs<M>,
): Promise<FunctionReturnType<M>> {
  try {
    return await convex.mutation(reference, args);
  } catch (e) {
    throw toBackendError(e);
  }
}

/**
 * purpose: Run an action as this device.
 * @param reference: (FunctionReference<'action'>) The action, for example
 *        api.voice.livekitToken.
 * @param args: (FunctionArgs) The action's arguments.
 * @return: (Promise<FunctionReturnType>) The action's result.
 * @raises: BackendError when the call fails.
 */
export async function callAction<A extends FunctionReference<'action'>>(
  reference: A,
  args: FunctionArgs<A>,
): Promise<FunctionReturnType<A>> {
  try {
    return await convex.action(reference, args);
  } catch (e) {
    throw toBackendError(e);
  }
}
