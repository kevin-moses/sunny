// sunny_app/src/backend/api.ts
//
// Purpose: Typed calls to Sunny's backend as the paired device: Postgres RPCs through
// PostgREST (callRpc) and Edge Functions (invokeFunction, which unwraps Sunny's
// { data, error: { message, code } } envelope). Every failure is a BackendError with a
// message safe to show and the HTTP status (0 for network failures), so callers can
// detect, for example, a 403 meaning the device was removed from its household.
//
// Last modified: 2026-10-28

import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js';

import { errorMessage } from '../errors';
import { supabase } from './supabase';

/** An error from the Sunny backend, with a message safe to show and the HTTP status. */
export class BackendError extends Error {
  readonly status: number;

  /**
   * purpose: Create a backend error.
   * @param message: (string) Message safe to show to the user.
   * @param status: (number) HTTP status; 0 when the request never got a response.
   */
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
  }
}

/** Shape of Sunny's Edge Function response envelope. */
interface Envelope<T> {
  data?: T | null;
  error?: { message?: string; code?: string } | null;
}

/**
 * purpose: Call a Postgres RPC as this device.
 * @param name: (string) RPC name, for example "get_day_view".
 * @param params: (Record<string, unknown>) Named arguments.
 * @return: (Promise<T>) The RPC result.
 * @raises: BackendError carrying the HTTP status when the call fails.
 */
export async function callRpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error, status } = await supabase.rpc(name, params);
  if (error) {
    throw new BackendError(error.message || `Request failed (${status})`, status);
  }
  return data as T;
}

/**
 * purpose: Read the message of a failed Edge Function response. Sunny's functions answer
 *          errors with a non-2xx status and a { data, error: { message, code } } body.
 * @param response: (unknown) The Response held in the error context.
 * @param status: (number) The HTTP status, used in the fallback message.
 * @return: (Promise<string>) body.error.message, or "Request failed (<status>)" when the
 *          body is missing or unreadable.
 */
async function readErrorMessage(response: unknown, status: number): Promise<string> {
  const fallback = `Request failed (${status})`;
  if (!(response instanceof Response)) return fallback;
  try {
    const body = (await response.json()) as Envelope<unknown> | null;
    return body?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * purpose: Convert an error returned by supabase.functions.invoke into a BackendError.
 * @param error: (unknown) The error from invoke.
 * @return: (Promise<BackendError>) Error carrying the server's message and status.
 */
async function toBackendError(error: unknown): Promise<BackendError> {
  if (error instanceof FunctionsHttpError || error instanceof FunctionsRelayError) {
    const response: unknown = error.context;
    const status = response instanceof Response ? response.status : 500;
    return new BackendError(await readErrorMessage(response, status), status);
  }
  if (error instanceof FunctionsFetchError) {
    return new BackendError('Could not reach Sunny. Check the internet connection.', 0);
  }
  return new BackendError(errorMessage(error, 'Request failed'), 0);
}

/**
 * purpose: Call an Edge Function as this device and unwrap its { data, error } envelope.
 * @param name: (string) Function name, for example "livekit-token".
 * @param body: (Record<string, unknown>) JSON body.
 * @return: (Promise<T>) The envelope's `data` payload.
 * @raises: BackendError with the server's message when the call or the envelope fails.
 */
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<Envelope<T>>(name, { body });
  if (error) throw await toBackendError(error);
  if (data?.error) throw new BackendError(data.error.message ?? 'Request failed', 400);
  if (data?.data === undefined || data.data === null) throw new BackendError('Empty response', 500);
  return data.data;
}
