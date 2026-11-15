import { ConvexError } from 'convex/values';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';

import type { AppErrorCode, AppErrorData } from '../../../sunny_backend/convex/lib/errors';
import { convex } from './convex';

export class BackendError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
  }
}

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  limit: 429,
};

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

export const NOT_CONNECTED_MESSAGE = 'This device is no longer connected to a family.';

const NETWORK_MESSAGES = [
  'Network request failed',
  'Network request timed out',
  'Failed to fetch',
  'Connection lost while action was in flight',
];

export const OFFLINE_ERROR_MESSAGE = 'Could not reach Sunny. Check the internet connection.';

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
