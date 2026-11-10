// sunny_app/src/voice/localAudio.ts
//
// Purpose: Turns this device's microphone fully off in a LiveKit room: every local audio
// track is stopped (the capture ends, so the iOS microphone indicator goes away) and
// unpublished. Muting is not enough: a muted track still holds the microphone.
//
// It also stops an audio track that is still waiting to publish, which is where the
// pre-connect microphone of a start that never connected sits. livekit-client keeps those in
// a private field, LocalParticipant.pendingPublishPromises (a Map from track to promise; read
// in livekit-client 2.23.0, dist/livekit-client.esm.mjs, publishOrRepublishTrack). There is no
// public way to reach such a track, so the field is read defensively: if a future version
// renames it or changes its shape, nothing here throws and that step is skipped, and LiveKit
// still stops the track itself when its 15 s publish timeout ends (the same function:
// "publishing rejected as engine not connected within timeout").
//
// Last modified: 2026-11-09

import type { Room } from 'livekit-client';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/**
 * purpose: Stop the audio tracks still waiting to publish, read from livekit-client's private
 *          pendingPublishPromises map; does nothing when that field is missing or not a Map.
 * @param participant: (unknown) The room's local participant.
 * @return: (void)
 */
function stopPendingAudio(participant: unknown): void {
  const pending = (participant as { pendingPublishPromises?: unknown }).pendingPublishPromises;
  if (!(pending instanceof Map)) return;
  pending.forEach((_publish, track: unknown) => {
    const candidate = track as { kind?: unknown; stop?: unknown } | null;
    if (candidate?.kind !== 'audio' || typeof candidate.stop !== 'function') return;
    try {
      (candidate.stop as () => void)();
    } catch (error) {
      logger.warning('Voice', `Stopping a waiting microphone failed: ${errorMessage(error)}`);
    }
  });
}

/**
 * purpose: Stop and unpublish every local audio track of a room, including one still waiting
 *          to publish.
 * @param room: (Room) The room.
 * @return: (Promise<void>) Resolves when every track is stopped and unpublishing has
 *          finished; failures are logged, never thrown.
 */
export async function stopLocalAudio(room: Room): Promise<void> {
  const participant = room.localParticipant;
  stopPendingAudio(participant);
  const published = [...participant.audioTrackPublications.values()];
  await Promise.all(
    published.map(async (publication) => {
      const track = publication.track;
      if (track === undefined) return;
      track.stop();
      try {
        await participant.unpublishTrack(track);
      } catch (error) {
        logger.warning('Voice', `Unpublishing the microphone failed: ${errorMessage(error)}`);
      }
    }),
  );
}
