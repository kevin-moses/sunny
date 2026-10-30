// sunny_app/src/voice/__tests__/voiceToken.test.ts
//
// Purpose: Unit tests for the voice token source: the voice.livekitToken action arguments built from
// the in-flight start's request, the response mapping, the reset of the request after the
// fetch, cancellation, and that background fetches reuse the last response (or call through
// when there is none) instead of calling the backend.
//
// Last modified: 2026-10-29

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { TaskInstanceId } from '../../backend/convexApi';
import { StartCancelledError, createTokenSource } from '../voiceToken';

const mockInvoke = jest.fn<(name: string, body: Record<string, unknown>) => Promise<unknown>>();
let capturedFn: (() => Promise<unknown>) | undefined;

jest.mock('livekit-client', () => ({
  TokenSource: {
    literal: (fn: () => Promise<unknown>) => {
      capturedFn = fn;
      return { literal: true };
    },
  },
}));

jest.mock('../../backend/api', () => ({
  callAction: (reference: unknown, body: Record<string, unknown>) => {
    const { getFunctionName } = jest.requireActual<typeof import('convex/server')>('convex/server');
    return mockInvoke(getFunctionName(reference as never), body);
  },
}));

const RESPONSE = {
  serverUrl: 'wss://x',
  roomName: 'r',
  participantName: 'p',
  participantToken: 'jwt',
};

beforeEach(() => {
  jest.clearAllMocks();
  capturedFn = undefined;
  mockInvoke.mockResolvedValue(RESPONSE);
});

describe('createTokenSource', () => {
  it('fetches for the in-flight start request and maps the response', async () => {
    createTokenSource().beginStart({
      trigger: 'notification_tap',
      taskInstanceId: 'abc' as TaskInstanceId,
    });
    const result = await capturedFn?.();
    expect(mockInvoke).toHaveBeenCalledWith('voice:livekitToken', {
      trigger: 'notification_tap',
      taskInstanceId: 'abc' as TaskInstanceId,
    });
    expect(result).toEqual({ serverUrl: 'wss://x', participantToken: 'jwt' });
  });

  it('omits the task instance when the tap has none', async () => {
    createTokenSource().beginStart({ trigger: 'notification_tap' });
    await capturedFn?.();
    expect(mockInvoke).toHaveBeenCalledWith('voice:livekitToken', { trigger: 'notification_tap' });
  });

  it('resets to the talk request after the in-flight fetch', async () => {
    const { beginStart } = createTokenSource();
    beginStart({ trigger: 'notification_tap', taskInstanceId: 'abc' as TaskInstanceId });
    await capturedFn?.();
    mockInvoke.mockClear();
    await capturedFn?.();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('calls through on the first background fetch with the talk request', async () => {
    createTokenSource();
    const result = await capturedFn?.();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('voice:livekitToken', { trigger: 'talk' });
    expect(result).toEqual({ serverUrl: 'wss://x', participantToken: 'jwt' });
  });

  it('reuses the last response for background fetches without calling the backend', async () => {
    createTokenSource();
    await capturedFn?.();
    mockInvoke.mockClear();
    mockInvoke.mockRejectedValue(new Error('offline'));
    await expect(capturedFn?.()).resolves.toEqual({
      serverUrl: 'wss://x',
      participantToken: 'jwt',
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('uses the response of an in-flight start for later background fetches', async () => {
    const { beginStart } = createTokenSource();
    mockInvoke.mockResolvedValue({ ...RESPONSE, participantToken: 'fresh' });
    beginStart({ trigger: 'talk' });
    await capturedFn?.();
    mockInvoke.mockClear();
    await expect(capturedFn?.()).resolves.toEqual({
      serverUrl: 'wss://x',
      participantToken: 'fresh',
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('propagates backend failures of an in-flight start and still resets the request', async () => {
    const { beginStart } = createTokenSource();
    mockInvoke.mockRejectedValue(new Error('403'));
    beginStart({ trigger: 'talk' });
    await expect(capturedFn?.()).rejects.toThrow('403');
    mockInvoke.mockResolvedValue(RESPONSE);
    await capturedFn?.();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('throws StartCancelledError when the start is aborted during the fetch', async () => {
    const controller = new AbortController();
    createTokenSource().beginStart({ trigger: 'talk' }, controller.signal);
    mockInvoke.mockImplementation(async () => {
      controller.abort();
      return RESPONSE;
    });
    await expect(capturedFn?.()).rejects.toBeInstanceOf(StartCancelledError);
  });

  it('does not call the backend when the start was aborted before the fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    createTokenSource().beginStart({ trigger: 'talk' }, controller.signal);
    await expect(capturedFn?.()).rejects.toBeInstanceOf(StartCancelledError);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('cancelStart drops the in-flight mark', async () => {
    const { beginStart, cancelStart } = createTokenSource();
    beginStart({ trigger: 'notification_tap', taskInstanceId: 'abc' as TaskInstanceId });
    cancelStart();
    await capturedFn?.();
    expect(mockInvoke).toHaveBeenCalledWith('voice:livekitToken', { trigger: 'talk' });
  });
});
