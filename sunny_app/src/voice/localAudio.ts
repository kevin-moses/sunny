import type { Room } from 'livekit-client';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

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
