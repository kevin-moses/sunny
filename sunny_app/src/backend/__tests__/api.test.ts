// sunny_app/src/backend/__tests__/api.test.ts
//
// Purpose: Unit tests for api.ts: the mapping from ConvexError codes to BackendError statuses
// (forbidden 403, unauthenticated 401, not_found 404, invalid 400, limit 429), the fallbacks
// for unknown codes, malformed payloads, network failures and unexpected errors, and that
// callMutation / callAction wrap failures of the Convex client.
//
// Last modified: 2026-10-29

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConvexError } from 'convex/values';

import { BackendError, callAction, callMutation, toBackendError } from '../api';

const mockMutation = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockAction = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('../convex', () => ({
  convex: {
    mutation: (...args: unknown[]) => mockMutation(...args),
    action: (...args: unknown[]) => mockAction(...args),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('toBackendError', () => {
  it.each([
    ['not_found', 404],
    ['invalid', 400],
    ['limit', 429],
  ])('maps the %s code to status %i and keeps the message', (code, status) => {
    const error = toBackendError(new ConvexError({ code, message: 'Safe message' }));
    expect(error).toBeInstanceOf(BackendError);
    expect(error.status).toBe(status);
    expect(error.message).toBe('Safe message');
  });

  it.each([
    ['forbidden', 403],
    ['unauthenticated', 401],
  ])('maps %s to status %i with a calm fixed message', (code, status) => {
    const error = toBackendError(new ConvexError({ code, message: 'Server internals' }));
    expect(error).toMatchObject({
      status,
      message: 'This device is no longer connected to a family.',
    });
  });

  it('gives an unknown code status 0 with the server message', () => {
    const error = toBackendError(new ConvexError({ code: 'weird', message: 'Odd' }));
    expect(error).toMatchObject({ status: 0, message: 'Odd' });
  });

  it('uses the generic message for a ConvexError with a malformed payload', () => {
    expect(toBackendError(new ConvexError('just a string'))).toMatchObject({
      status: 0,
      message: 'Something went wrong. Please try again.',
    });
    expect(toBackendError(new ConvexError({ code: 5 }))).toMatchObject({ status: 0 });
  });

  it.each([
    'Network request failed',
    'Network request timed out',
    'Failed to fetch',
    'Connection lost while action was in flight',
  ])('maps the known connection failure "%s" to the offline message', (message) => {
    expect(toBackendError(new Error(message))).toMatchObject({
      status: 0,
      message: 'Could not reach Sunny. Check the internet connection.',
    });
  });

  it('does not treat unrelated messages that mention connect or fetch as offline', () => {
    const error = toBackendError(new Error('Could not fetch the connector row'));
    expect(error.message).toBe('Something went wrong. Please try again.');
  });

  it('hides unexpected server errors behind the generic message', () => {
    const error = toBackendError(new Error('[Request ID: abc] Server Error'));
    expect(error).toMatchObject({ status: 0, message: 'Something went wrong. Please try again.' });
  });

  it('returns a BackendError unchanged and handles non-Error values', () => {
    const original = new BackendError('x', 403);
    expect(toBackendError(original)).toBe(original);
    expect(toBackendError(undefined).status).toBe(0);
  });
});

describe('callMutation and callAction', () => {
  it('return the client result', async () => {
    mockMutation.mockResolvedValue(null);
    mockAction.mockResolvedValue({ ok: true });
    expect(await callMutation('m' as never, {} as never)).toBeNull();
    expect(await callAction('a' as never, {} as never)).toEqual({ ok: true });
  });

  it('wrap failures in a BackendError with the code status', async () => {
    mockAction.mockRejectedValue(new ConvexError({ code: 'forbidden', message: 'Removed' }));
    await expect(callAction('a' as never, {} as never)).rejects.toMatchObject({
      status: 403,
      message: 'This device is no longer connected to a family.',
    });
    mockMutation.mockRejectedValue(new ConvexError({ code: 'not_found', message: 'Gone' }));
    await expect(callMutation('m' as never, {} as never)).rejects.toMatchObject({ status: 404 });
  });
});
