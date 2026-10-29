// sunny_app/src/voice/voiceToken.ts
//
// Purpose: Token source for the voice session. Calls the livekit-token Supabase Edge
// Function (which checks the device pairing and embeds the household in the participant
// metadata the agent reads) and maps its { serverUrl, participantToken } response to what
// LiveKit's useSession expects.
//
// The source is a non-caching TokenSource.literal, so LiveKit calls the function on every
// fetch, but the function only calls the backend when it has to:
//   - While a start is in flight (beginStart ... the token fetch) it fetches a fresh token
//     for that start's request (trigger plus optional task instance) and then resets the
//     request to the Talk request. Each fetch mints a new room, so only starts pay for it.
//   - If the start was cancelled (its AbortSignal fired) by the time the response arrives, it
//     throws StartCancelledError so LiveKit never connects with the token.
//   - Outside a start, LiveKit also calls the function un-awaited from end() and when the room
//     disconnects by itself (a rejection there would be an unhandled promise rejection), and
//     uses the result only to pre-warm a connection. Those calls get the last successful
//     response. The very first such call (LiveKit's prepareConnection on mount, whose
//     rejection LiveKit catches) performs a real fetch.
//
// Last modified: 2026-10-28

import { TokenSource } from 'livekit-client';

import { invokeFunction } from '../backend/api';

/** Why a session is being started; matches the livekit-token function's triggers. */
type VoiceTrigger = 'talk' | 'notification_tap';

/** What starts a voice session. */
export interface SessionRequest {
  trigger: VoiceTrigger;
  taskInstanceId?: string;
}

/** Request used for the Talk button and whenever no other session is being started. */
export const TALK_REQUEST: SessionRequest = { trigger: 'talk' };

/** The livekit-token function's response data, reduced to what LiveKit needs. */
interface LiveKitTokenResponse {
  serverUrl: string;
  participantToken: string;
}

/** Thrown by the token function when the start it was serving has been cancelled. */
export class StartCancelledError extends Error {
  /**
   * purpose: Create the cancellation error.
   */
  constructor() {
    super('Voice session start was cancelled');
    this.name = 'StartCancelledError';
  }
}

/** The voice token source and the controls for the start it serves. */
interface VoiceTokenSource {
  source: ReturnType<typeof TokenSource.literal>;
  /**
   * Marks a start as in flight: the next token fetch is for this request. The fetch throws
   * StartCancelledError if the signal has aborted by the time it completes.
   */
  beginStart: (request: SessionRequest, signal?: AbortSignal) => void;
  /** Clears an in-flight mark the token function never consumed (the start failed first). */
  cancelStart: () => void;
}

/** A start waiting for its token fetch. */
interface PendingStart {
  request: SessionRequest;
  signal?: AbortSignal;
}

/**
 * purpose: Create the token source for useSession together with the controls that tell it
 *          which start it is serving.
 * @return: (VoiceTokenSource) the token source, beginStart and cancelStart
 */
export function createTokenSource(): VoiceTokenSource {
  let pending: PendingStart | null = null;
  let lastResponse: LiveKitTokenResponse | null = null;

  /**
   * purpose: Fetch a token from the backend for a request and remember it.
   * @param request: (SessionRequest) what the token is for
   * @return: (Promise<LiveKitTokenResponse>) the token response
   */
  const fetchToken = async (request: SessionRequest): Promise<LiveKitTokenResponse> => {
    const body: Record<string, unknown> = { trigger: request.trigger };
    if (request.taskInstanceId) body.taskInstanceId = request.taskInstanceId;
    const response = await invokeFunction<LiveKitTokenResponse>('livekit-token', body);
    lastResponse = { serverUrl: response.serverUrl, participantToken: response.participantToken };
    return lastResponse;
  };

  /**
   * purpose: The token function LiveKit calls on every fetch (see the file header for when
   *          it reaches the backend).
   * @return: (Promise<LiveKitTokenResponse>) the token response
   * @raises: StartCancelledError when the start it serves was cancelled.
   */
  const source = TokenSource.literal(async () => {
    const start = pending;
    if (start === null) return lastResponse ?? fetchToken(TALK_REQUEST);
    // Claim the start now, so a background call during the fetch cannot take it too; this
    // also resets the request to the Talk request as soon as it has been used.
    pending = null;
    if (start.signal?.aborted) throw new StartCancelledError();
    const response = await fetchToken(start.request);
    if (start.signal?.aborted) throw new StartCancelledError();
    return response;
  });
  return {
    source,
    /**
     * purpose: Mark a start as in flight for a request.
     * @param request: (SessionRequest) what the next token fetch is for
     * @param signal: (AbortSignal | undefined) aborts the start
     */
    beginStart: (request, signal) => {
      pending = { request, signal };
    },
    /**
     * purpose: Drop an in-flight mark that no token fetch consumed.
     */
    cancelStart: () => {
      pending = null;
    },
  };
}
