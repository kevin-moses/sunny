// sunny_app/src/voice/localAudio.ts
//
// Purpose: Turns this device's microphone fully off in a LiveKit room: every local audio
// track is stopped (the capture ends, so the iOS microphone indicator goes away) and
// unpublished. Muting is not enough: a muted track still holds the microphone. It also stops
// an audio track that is still waiting to publish, which is where the pre-connect microphone
// of a start that never connected sits; that list is private to livekit-client
// (LocalParticipant.pendingPublishPromises), so it is read defensively, and if a future
// livekit-client drops it LiveKit still stops such a track itself when its 15 s publish
// timeout ends.
//
// Last modified: 2026-11-09

import type { Room } from 'livekit-client';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/** The private livekit-client field holding tracks that wait to publish. */
interface PendingPublishes {
  pendingPublishPromises?: Map<{ kind?: string; stop: () => void }, unknown>;
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
  const pending = (participant as unknown as PendingPublishes).pendingPublishPromises;
  pending?.forEach((_publish, track) => {
    if (track.kind === 'audio') track.stop();
  });
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
