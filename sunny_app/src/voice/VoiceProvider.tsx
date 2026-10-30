// sunny_app/src/voice/VoiceProvider.tsx
//
// Purpose: Owns the LiveKit voice session for the app. It wraps the app and provides
// useVoice() (connect, disconnect, status, error) plus useConversation() (microphone, agent
// state and tracks, transcript). An unpaired device gets an idle useVoice() and nothing
// else; for a paired device an inner provider owns the session:
//   - Token: useSession with a non-caching token source (voiceToken.ts) that calls the
//     voice.livekitToken Convex action on every session start. The request (trigger 'talk' for
//     the Talk button, 'notification_tap' with an optional taskInstanceId for a tapped
//     push) is handed to the token source right before session.start(); the token source
//     resets it after use and calls the backend only for a start in flight. A tapped push
//     whose task instance no longer exists (404) is retried once as a plain Talk start.
//   - Cancel: session.start() gets an AbortSignal that endSession() aborts, so pressing End
//     while the token is being fetched (the room is still disconnected) stops the start; a
//     cancelled start shows no error.
//   - Connect: session.start() with its defaults (microphone enabled with LiveKit's
//     pre-connect audio buffer, so speech said while connecting is kept).
//   - Agent failure: useSession is given a 20 second agent connect timeout; when the agent
//     state becomes 'failed' (no agent in time, or the agent left) the failure reasons are
//     surfaced as the error and the session is ended.
//   - isInteractive: true while connecting after a Talk press, connected, or reconnecting.
//   - Phone RPC (findContact, sendMessage) is registered on the room; app logs are forwarded
//     to the agent while connected; push notification taps start a session.
//   - The iOS audio session is configured and activated by registerGlobals() in index.ts
//     (autoConfigureAudioSession), so no AudioSession start/stop calls are needed here.
//
// Last modified: 2026-10-29

import {
  SessionProvider,
  useAgent,
  useLocalParticipant,
  useSession,
  useSessionMessages,
} from '@livekit/components-react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { BackendError } from '../backend/api';
import type { PairedDevice } from '../backend/pairing';
import { errorMessage } from '../errors';
import { attachLogRoom, detachLogRoom, logger } from '../logging/logger';
import { usePushNotifications, type NotificationTap } from '../notifications/push';
import { registerPhoneRpcMethods } from './rpc';
import {
  ConversationContext,
  VoiceContext,
  type ConversationApi,
  type VoiceApi,
  type VoiceConnectionState,
} from './voiceContext';
import {
  StartCancelledError,
  TALK_REQUEST,
  createTokenSource,
  type SessionRequest,
} from './voiceToken';

export { useConversation, useVoice } from './voiceContext';

/** How long to wait for an agent to join after connecting, in milliseconds. */
const AGENT_CONNECT_TIMEOUT_MS = 20_000;

/** Error shown when the agent failed without LiveKit giving a reason. */
const AGENT_NOT_CONNECTED_MESSAGE = 'Agent did not connect to the Room';

/** The voice surface of an unpaired device: never interactive, connecting does nothing. */
const IDLE_VOICE: VoiceApi = {
  isInteractive: false,
  connectionState: 'disconnected',
  error: null,
  clearError: () => undefined,
  connect: async () => undefined,
  disconnect: async () => undefined,
};

/**
 * purpose: Map LiveKit's connection state to the app's four-state model.
 * @param state: (ConnectionState) the LiveKit state
 * @param starting: (boolean) true after a start was requested and until the session ends,
 *                  which makes the token-fetch gap report 'connecting'
 * @return: (VoiceConnectionState) the exposed state
 */
function toVoiceConnectionState(state: ConnectionState, starting: boolean): VoiceConnectionState {
  switch (state) {
    case ConnectionState.Connected:
      return 'connected';
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return 'reconnecting';
    case ConnectionState.Connecting:
      return 'connecting';
    default:
      return starting ? 'connecting' : 'disconnected';
  }
}

/**
 * purpose: Tell whether a failed notification-tap start should be retried as a Talk start:
 *          the voice.livekitToken action answered not_found (404), meaning the task instance
 *          no longer exists.
 * @param request: (SessionRequest) the request that failed
 * @param error: (unknown) the failure
 * @return: (boolean) true when a plain Talk retry is appropriate
 */
function isStaleTaskTap(request: SessionRequest, error: unknown): boolean {
  return (
    request.trigger === 'notification_tap' && error instanceof BackendError && error.status === 404
  );
}

/**
 * purpose: Own the LiveKit session for a paired device and provide the voice contexts.
 * @param props: ({ children: ReactNode }) the app subtree
 * @return: (ReactElement) the children wrapped in the session and voice contexts
 */
function PairedVoiceProvider({ children }: { children: ReactNode }): ReactElement {
  const [{ source: tokenSource, beginStart, cancelStart }] = useState(createTokenSource);
  // Bumped when a session is ended, so a start that fails afterwards is not reported.
  const generationRef = useRef(0);
  // Aborts the start that is waiting for its token or connection; null when none is.
  const startAbortRef = useRef<AbortController | null>(null);
  // The agent failure already handled by ending the session, so it is ended only once.
  const handledFailureRef = useRef<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = useSession(tokenSource, {
    agentConnectTimeoutMilliseconds: AGENT_CONNECT_TIMEOUT_MS,
  });
  const agent = useAgent(session);
  const { messages, send } = useSessionMessages(session);
  const { isMicrophoneEnabled } = useLocalParticipant({ room: session.room });

  const rawState = session.connectionState;
  const connectionState = toVoiceConnectionState(rawState, isStarting);
  const isActive = connectionState !== 'disconnected';
  const isConnected = rawState === ConnectionState.Connected;
  const agentJoined = agent.internal.agentParticipant !== null;
  const agentFailure =
    agent.state === 'failed' ? agent.failureReasons.join(' ') || AGENT_NOT_CONNECTED_MESSAGE : null;

  // Show a new agent failure as the app error. This adjusts state while rendering (the
  // pattern React documents for reacting to a changed value) instead of in an effect; the
  // error then outlives the failure, which clears when the session ends.
  const [shownFailure, setShownFailure] = useState<string | null>(null);
  if (agentFailure !== shownFailure) {
    setShownFailure(agentFailure);
    if (agentFailure !== null) setError(agentFailure);
  }

  /**
   * purpose: Clear per-session state once a session has ended.
   * @return: (void)
   */
  const resetSessionState = useCallback((): void => {
    setIsStarting(false);
  }, []);

  /**
   * purpose: Run an action, surfacing a failure as the app error.
   * @param action: (() => Promise<unknown>) the action to run
   * @return: (Promise<void>) resolves when the action finished or its failure was reported
   */
  const runAndReport = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  /**
   * purpose: Run one session.start() for a request with a fresh abort signal that
   *          endSession() can fire. Always clears the token source's in-flight mark after.
   * @param request: (SessionRequest) what the token fetch is for
   * @return: (Promise<void>) resolves once LiveKit connected; rejects when the start failed
   */
  const startOnce = useCallback(
    async (request: SessionRequest): Promise<void> => {
      const controller = new AbortController();
      startAbortRef.current = controller;
      beginStart(request, controller.signal);
      try {
        await session.start({ signal: controller.signal });
      } finally {
        cancelStart();
        if (startAbortRef.current === controller) startAbortRef.current = null;
      }
    },
    [session, beginStart, cancelStart],
  );

  /**
   * purpose: Start a session for a request. A tapped notification whose task instance is gone
   *          (404) is retried once as a Talk start; a cancelled start shows no error.
   * @param request: (SessionRequest) the Talk or notification-tap request
   * @return: (Promise<void>) resolves once LiveKit finished (or failed) connecting
   */
  const startSession = useCallback(
    async (request: SessionRequest): Promise<void> => {
      if (isActive) {
        logger.info('Voice', 'Ignoring start request: a session is already active', {
          task_instance_id: request.taskInstanceId ?? null,
        });
        return;
      }
      generationRef.current += 1;
      const generation = generationRef.current;
      setError(null);
      setIsStarting(true);
      try {
        try {
          await startOnce(request);
        } catch (e) {
          if (generation !== generationRef.current || !isStaleTaskTap(request, e)) throw e;
          logger.warning('Voice', 'Task instance not found; starting a plain conversation', {
            task_instance_id: request.taskInstanceId ?? null,
          });
          await startOnce(TALK_REQUEST);
        }
      } catch (e) {
        if (generation === generationRef.current && !(e instanceof StartCancelledError)) {
          logger.error('Voice', `Connect failed: ${errorMessage(e)}`);
          setError(errorMessage(e));
        }
        resetSessionState();
      }
    },
    [isActive, startOnce, resetSessionState],
  );

  /**
   * purpose: Public connect: start a Talk session.
   * @return: (Promise<void>) resolves once LiveKit finished (or failed) connecting
   */
  const connect = useCallback((): Promise<void> => startSession(TALK_REQUEST), [startSession]);

  /**
   * purpose: End the session in LiveKit and cancel a start that is still fetching its token;
   *          later start failures are then not reported as errors.
   * @return: (Promise<void>) resolves when LiveKit has ended the session
   */
  const endSession = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    startAbortRef.current?.abort();
    try {
      await session.end();
    } catch (e) {
      logger.error('Voice', `Disconnect failed: ${errorMessage(e)}`);
    }
  }, [session]);

  /**
   * purpose: Public disconnect: end the session and reset the per-session state.
   * @return: (Promise<void>) resolves when the session has ended
   */
  const disconnect = useCallback(async (): Promise<void> => {
    await endSession();
    resetSessionState();
  }, [endSession, resetSessionState]);

  /**
   * purpose: Start a session for a tapped notification (ignored while one is active).
   * @param tap: (NotificationTap) the tap, with the optional task instance
   * @return: (void)
   */
  const onNotificationTap = useCallback(
    (tap: NotificationTap): void => {
      void startSession({ trigger: 'notification_tap', taskInstanceId: tap.taskInstanceId });
    },
    [startSession],
  );
  usePushNotifications(onNotificationTap);

  // A session that ends on its own (server hang-up) resets the state; disconnect() covers
  // the sessions the app ends itself.
  useEffect(() => {
    session.room.on(RoomEvent.Disconnected, resetSessionState);
    return () => {
      session.room.off(RoomEvent.Disconnected, resetSessionState);
    };
  }, [session.room, resetSessionState]);

  // An agent that never joined, did not finish starting, or left ends the session.
  // endSession changes identity with the session, so a ref remembers the failure already
  // handled; a failure ends the session once and the guard re-arms when it clears.
  useEffect(() => {
    if (agentFailure === null) {
      handledFailureRef.current = null;
    } else if (handledFailureRef.current !== agentFailure) {
      handledFailureRef.current = agentFailure;
      void endSession();
    }
  }, [agentFailure, endSession]);

  // Forward app logs to the agent while connected.
  useEffect(() => {
    if (!isConnected) return;
    attachLogRoom(session.room);
    return detachLogRoom;
  }, [isConnected, session.room]);

  // Phone RPC methods the agent calls (findContact, sendMessage).
  useEffect(() => registerPhoneRpcMethods(session.room), [session.room]);

  /**
   * purpose: Toggle the local microphone.
   * @return: (Promise<void>) resolves when done; a failure is shown as the app error
   */
  const toggleMicrophone = useCallback(
    (): Promise<void> =>
      runAndReport(() => session.room.localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)),
    [runAndReport, session.room, isMicrophoneEnabled],
  );

  /**
   * purpose: Send a typed chat message to the agent.
   * @param text: (string) the message
   * @return: (Promise<void>) resolves when sent; a failure is shown as the app error
   */
  const sendChat = useCallback(
    (text: string): Promise<void> => runAndReport(() => send(text)),
    [runAndReport, send],
  );

  /**
   * purpose: Dismiss the shown error.
   * @return: (void)
   */
  const clearError = useCallback((): void => setError(null), []);

  const voiceValue = useMemo<VoiceApi>(
    () => ({ isInteractive: isActive, connectionState, error, clearError, connect, disconnect }),
    [isActive, connectionState, error, clearError, connect, disconnect],
  );

  const conversationValue = useMemo<ConversationApi>(
    () => ({
      isMicrophoneEnabled,
      toggleMicrophone,
      agentJoined,
      agentState: agent.state,
      agentAudioTrack: agent.microphoneTrack,
      localAudioTrack: session.local.microphoneTrack,
      messages,
      sendChat,
    }),
    [
      isMicrophoneEnabled,
      toggleMicrophone,
      agentJoined,
      agent.state,
      agent.microphoneTrack,
      session.local.microphoneTrack,
      messages,
      sendChat,
    ],
  );

  return (
    <SessionProvider session={session}>
      <VoiceContext.Provider value={voiceValue}>
        <ConversationContext.Provider value={conversationValue}>
          {children}
        </ConversationContext.Provider>
      </VoiceContext.Provider>
    </SessionProvider>
  );
}

/**
 * purpose: Provide the voice session and conversation state to the app.
 * @param props: ({ pairedDevice: PairedDevice | null, children: ReactNode }) the paired
 *               device (null gives an idle, unconnectable voice API and mounts no session)
 *               and the app subtree
 * @return: (ReactElement) the children wrapped in the voice contexts
 */
export function VoiceProvider(props: {
  pairedDevice: PairedDevice | null;
  children: ReactNode;
}): ReactElement {
  const { pairedDevice, children } = props;
  if (pairedDevice === null) {
    return <VoiceContext.Provider value={IDLE_VOICE}>{children}</VoiceContext.Provider>;
  }
  return <PairedVoiceProvider>{children}</PairedVoiceProvider>;
}
