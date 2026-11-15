import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { PairedDevice } from '../../backend/pairing';
import { DEFAULT_TUNING, TUNING_SPECS } from '../../display/tuning';
import { TuningContext } from '../../display/TuningProvider';
import type { TuningControls } from '../../display/TuningProvider';
import { VoiceProvider, useVoice } from '../VoiceProvider';
import type { VoiceApi } from '../voiceContext';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeTrack {
  kind: 'audio';
  stop: jest.Mock;
}

function makeTrack(): FakeTrack {
  return { kind: 'audio', stop: jest.fn() };
}

let mockTokenFn: (() => Promise<unknown>) | null = null;
let mockToken: Deferred<unknown>;
let mockMic: Deferred<void>;
let mockMicTrack: FakeTrack;
let mockPendingTrack: FakeTrack;
const mockUseSessionOptions: unknown[] = [];

const mockRoom = {
  localParticipant: {
    audioTrackPublications: new Map<string, { track?: FakeTrack }>(),
    pendingPublishPromises: new Map<FakeTrack, unknown>(),
    setMicrophoneEnabled: jest.fn(async (on: boolean) => {
      if (!on) return;
      mockRoom.localParticipant.pendingPublishPromises.set(mockPendingTrack, null);
      await mockMic.promise;
      mockRoom.localParticipant.audioTrackPublications.set('mic', { track: mockMicTrack });
    }),
    unpublishTrack: jest.fn(async (_track: FakeTrack) => undefined),
  },
  connect: jest.fn(async (_url: string, _token: string) => undefined),
  disconnect: jest.fn(async () => undefined),
  on: jest.fn(),
  off: jest.fn(),
  registerRpcMethod: jest.fn(),
  unregisterRpcMethod: jest.fn(),
};

const mockSession = {
  room: mockRoom,
  connectionState: 'disconnected',
  local: { microphoneTrack: undefined },
  start: jest.fn(async (options: { signal?: AbortSignal }) => {
    const credentials = (await mockTokenFn!()) as { serverUrl: string; participantToken: string };
    if (options.signal?.aborted) throw new Error('aborted');
    await mockRoom.connect(credentials.serverUrl, credentials.participantToken);
  }),
  end: jest.fn(async () => undefined),
};

let mockAgent = {
  state: 'disconnected',
  failureReasons: [] as string[],
  internal: { agentParticipant: null },
  microphoneTrack: undefined,
};

jest.mock('@livekit/components-react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: (_source: unknown, options: unknown) => {
    mockUseSessionOptions.push(options);
    return mockSession;
  },
  useAgent: () => mockAgent,
  useSessionMessages: () => ({ messages: [], send: jest.fn() }),
  useLocalParticipant: () => ({
    isMicrophoneEnabled: false,
    localParticipant: mockRoom.localParticipant,
  }),
  useIsSpeaking: () => false,
}));

jest.mock('livekit-client', () => ({
  ConnectionState: {
    Disconnected: 'disconnected',
    Connecting: 'connecting',
    Connected: 'connected',
    Reconnecting: 'reconnecting',
    SignalReconnecting: 'signalReconnecting',
  },
  RoomEvent: { Disconnected: 'disconnected' },
  TokenSource: {
    literal: (fn: () => Promise<unknown>) => {
      mockTokenFn = fn;
      return { literal: true };
    },
  },
}));

jest.mock('../../backend/api', () => ({
  BackendError: class BackendError extends Error {},
  callAction: () => mockToken.promise,
}));
jest.mock('../../notifications/push', () => ({ usePushNotifications: () => undefined }));
jest.mock('../../logging/logger', () => ({
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
  attachLogRoom: jest.fn(),
  detachLogRoom: jest.fn(),
}));
jest.mock('expo-contacts', () => ({}));
jest.mock('expo-sms', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const DISPLAY = { householdId: 'h1', kind: 'home_display' } as unknown as PairedDevice;
const PHONE = { householdId: 'h1', kind: 'senior_phone' } as unknown as PairedDevice;

function makeProbe(): { Probe: () => null; get: () => VoiceApi } {
  let current: VoiceApi | null = null;
  const Probe = (): null => {
    current = useVoice();
    return null;
  };
  return { Probe, get: () => current! };
}

const probe = makeProbe();
const Probe = probe.Probe;

function voiceApi(): VoiceApi {
  return probe.get();
}

function renderProvider(device: PairedDevice, startTimeoutMs?: number): ReactTestRenderer {
  const controls = {
    tuning: { ...DEFAULT_TUNING, startTimeoutMs: startTimeoutMs ?? DEFAULT_TUNING.startTimeoutMs },
  } as TuningControls;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <TuningContext.Provider value={controls}>
        <VoiceProvider pairedDevice={device}>
          <Probe />
        </VoiceProvider>
      </TuningContext.Provider>,
    );
  });
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockToken = deferred();
  mockMic = deferred();
  mockMicTrack = makeTrack();
  mockPendingTrack = makeTrack();
  mockRoom.localParticipant.audioTrackPublications.clear();
  mockRoom.localParticipant.pendingPublishPromises.clear();
  mockUseSessionOptions.length = 0;
  mockAgent = { ...mockAgent, state: 'disconnected', failureReasons: [] };
});

describe('cancelling a start', () => {
  it('never connects and leaves no live microphone, even one that comes on late', async () => {
    const renderer = renderProvider(DISPLAY);
    act(() => {
      void voiceApi().connect();
    });
    await flush();
    expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, undefined, {
      preConnectBuffer: true,
    });

    await act(async () => {
      await voiceApi().disconnect();
    });
    expect(mockPendingTrack.stop).toHaveBeenCalled();

    mockToken.resolve({ serverUrl: 'wss://x', participantToken: 't' });
    await flush();
    expect(mockRoom.connect).not.toHaveBeenCalled();

    mockMic.resolve();
    await flush();
    expect(mockMicTrack.stop).toHaveBeenCalled();
    expect(mockRoom.localParticipant.unpublishTrack).toHaveBeenCalledWith(mockMicTrack);
    act(() => renderer.unmount());
  });

  it.each([
    ['before', true],
    ['after', false],
  ])(
    'a failed start turns off a microphone that came on %s the failure, and says so once',
    async (_when, micFirst) => {
      const renderer = renderProvider(PHONE);
      act(() => {
        void voiceApi().connect();
      });
      await flush();
      if (micFirst) {
        mockMic.resolve();
        await flush();
      }
      mockToken.reject(new Error('Token service failed'));
      await flush();
      if (!micFirst) {
        mockMic.resolve();
        await flush();
      }
      expect(mockRoom.connect).not.toHaveBeenCalled();
      expect(mockMicTrack.stop).toHaveBeenCalled();
      expect(mockRoom.localParticipant.unpublishTrack).toHaveBeenCalledWith(mockMicTrack);
      expect(voiceApi().error).toBe('Token service failed');
      expect(voiceApi().connectionState).toBe('disconnected');
      act(() => renderer.unmount());
    },
  );

  it('turns the microphone off when the provider unmounts', async () => {
    const renderer = renderProvider(DISPLAY);
    mockRoom.localParticipant.audioTrackPublications.set('mic', { track: mockMicTrack });
    act(() => renderer.unmount());
    await flush();
    expect(mockRoom.disconnect).toHaveBeenCalled();
    expect(mockMicTrack.stop).toHaveBeenCalled();
  });
});

describe('agent failure', () => {
  it('ends the session exactly once', async () => {
    mockAgent = { ...mockAgent, state: 'failed', failureReasons: ['Agent left'] };
    const renderer = renderProvider(DISPLAY);
    await flush();
    act(() => {
      renderer.update(
        <TuningContext.Provider value={{ tuning: DEFAULT_TUNING } as TuningControls}>
          <VoiceProvider pairedDevice={DISPLAY}>
            <Probe />
          </VoiceProvider>
        </TuningContext.Provider>,
      );
    });
    await flush();
    expect(mockSession.end).toHaveBeenCalledTimes(1);
    expect(voiceApi().error).toBe('Agent left');
    act(() => renderer.unmount());
  });
});

describe('agent connect timeout', () => {
  it('is never shorter than the longest tuned start timeout on the home display', () => {
    const renderer = renderProvider(DISPLAY, 30_000);
    expect(mockUseSessionOptions.at(-1)).toEqual({
      agentConnectTimeoutMilliseconds: TUNING_SPECS.startTimeoutMs.max,
    });
    act(() => renderer.unmount());
  });

  it('stays 20 s on the phone', () => {
    const renderer = renderProvider(PHONE, 30_000);
    expect(mockUseSessionOptions.at(-1)).toEqual({ agentConnectTimeoutMilliseconds: 20_000 });
    act(() => renderer.unmount());
  });
});

describe('phone RPC methods', () => {
  it('are registered on the phone', () => {
    const renderer = renderProvider(PHONE);
    const methods = mockRoom.registerRpcMethod.mock.calls.map((call) => call[0]);
    expect(methods).toEqual(['findContact', 'sendMessage']);
    act(() => renderer.unmount());
  });

  it('are not registered on the home display', () => {
    const renderer = renderProvider(DISPLAY);
    expect(mockRoom.registerRpcMethod).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
