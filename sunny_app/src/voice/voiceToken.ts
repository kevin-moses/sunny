import { TokenSource } from 'livekit-client';

import { callAction } from '../backend/api';
import { api, type TaskInstanceId } from '../backend/convexApi';

type VoiceTrigger = 'talk' | 'notification_tap';

export interface SessionRequest {
  trigger: VoiceTrigger;
  taskInstanceId?: TaskInstanceId;
}

export const TALK_REQUEST: SessionRequest = { trigger: 'talk' };

interface LiveKitTokenResponse {
  serverUrl: string;
  participantToken: string;
}

export class StartCancelledError extends Error {
  constructor() {
    super('Voice session start was cancelled');
    this.name = 'StartCancelledError';
  }
}

interface VoiceTokenSource {
  source: ReturnType<typeof TokenSource.literal>;
  beginStart: (request: SessionRequest, signal?: AbortSignal) => void;
  cancelStart: () => void;
}

interface PendingStart {
  request: SessionRequest;
  signal?: AbortSignal;
}

export function createTokenSource(): VoiceTokenSource {
  let pending: PendingStart | null = null;
  let lastResponse: LiveKitTokenResponse | null = null;

  const fetchToken = async (request: SessionRequest): Promise<LiveKitTokenResponse> => {
    const response = await callAction(api.voice.livekitToken, {
      trigger: request.trigger,
      ...(request.taskInstanceId ? { taskInstanceId: request.taskInstanceId } : {}),
    });
    lastResponse = { serverUrl: response.serverUrl, participantToken: response.participantToken };
    return lastResponse;
  };

  const source = TokenSource.literal(async () => {
    const start = pending;
    if (start === null) return lastResponse ?? fetchToken(TALK_REQUEST);
    pending = null;
    if (start.signal?.aborted) throw new StartCancelledError();
    const response = await fetchToken(start.request);
    if (start.signal?.aborted) throw new StartCancelledError();
    return response;
  });
  return {
    source,
    beginStart: (request, signal) => {
      pending = { request, signal };
    },
    cancelStart: () => {
      pending = null;
    },
  };
}
