import { describe, expect, it, jest } from '@jest/globals';
import type { Room } from 'livekit-client';

import { stopLocalAudio } from '../localAudio';

jest.mock('../../logging/logger', () => ({
  logger: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

interface FakeTrack {
  kind: string;
  stop: jest.Mock;
}

function makeTrack(kind = 'audio'): FakeTrack {
  return { kind, stop: jest.fn() };
}

function makeRoom(published: FakeTrack, pending?: unknown): { room: Room; unpublish: jest.Mock } {
  const unpublish = jest.fn(async () => undefined);
  const localParticipant: Record<string, unknown> = {
    audioTrackPublications: new Map([['mic', { track: published }]]),
    unpublishTrack: unpublish,
  };
  if (pending !== undefined) localParticipant.pendingPublishPromises = pending;
  return { room: { localParticipant } as unknown as Room, unpublish };
}

describe('stopLocalAudio', () => {
  it('stops and unpublishes published audio and stops audio waiting to publish', async () => {
    const mic = makeTrack();
    const waiting = makeTrack();
    const camera = makeTrack('video');
    const { room, unpublish } = makeRoom(
      mic,
      new Map<FakeTrack, unknown>([
        [waiting, null],
        [camera, null],
      ]),
    );
    await stopLocalAudio(room);
    expect(mic.stop).toHaveBeenCalled();
    expect(unpublish).toHaveBeenCalledWith(mic);
    expect(waiting.stop).toHaveBeenCalled();
    expect(camera.stop).not.toHaveBeenCalled();
  });

  it('skips the waiting step, without throwing, when the private field is absent', async () => {
    const mic = makeTrack();
    const { room, unpublish } = makeRoom(mic);
    await expect(stopLocalAudio(room)).resolves.toBeUndefined();
    expect(mic.stop).toHaveBeenCalled();
    expect(unpublish).toHaveBeenCalledWith(mic);
  });

  it('does not throw when the private field has another shape or a stop throws', async () => {
    for (const pending of [{}, 'x', null, [makeTrack()]]) {
      const mic = makeTrack();
      await expect(stopLocalAudio(makeRoom(mic, pending).room)).resolves.toBeUndefined();
      expect(mic.stop).toHaveBeenCalled();
    }
    const broken = makeTrack();
    broken.stop.mockImplementation(() => {
      throw new Error('already stopped');
    });
    const mic = makeTrack();
    const room = makeRoom(mic, new Map([[broken, null]])).room;
    await expect(stopLocalAudio(room)).resolves.toBeUndefined();
    expect(mic.stop).toHaveBeenCalled();
  });
});
