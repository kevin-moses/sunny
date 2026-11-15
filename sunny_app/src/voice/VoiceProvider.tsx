import {
  SessionProvider,
  useAgent,
  useIsSpeaking,
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
import { AGENT_CONNECT_TIMEOUT_MS, DISPLAY_AGENT_CONNECT_TIMEOUT_MS } from './agentTimeouts';
import { stopLocalAudio } from './localAudio';
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

const AGENT_NOT_CONNECTED_MESSAGE = 'Agent did not connect to the Room';

const IDLE_VOICE: VoiceApi = {
  isInteractive: false,
  connectionState: 'disconnected',
  error: null,
  clearError: () => undefined,
  connect: async () => undefined,
  disconnect: async () => undefined,
};

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

function isStaleTaskTap(request: SessionRequest, error: unknown): boolean {
  return (
    request.trigger === 'notification_tap' && error instanceof BackendError && error.status === 404
  );
}

function PairedVoiceProvider({
  phone,
  children,
}: {
  phone: boolean;
  children: ReactNode;
}): ReactElement {
  const [{ source: tokenSource, beginStart, cancelStart }] = useState(createTokenSource);
  const generationRef = useRef(0);
  const startAbortRef = useRef<AbortController | null>(null);
  const handledFailureRef = useRef<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = useSession(tokenSource, {
    agentConnectTimeoutMilliseconds: phone
      ? AGENT_CONNECT_TIMEOUT_MS
      : DISPLAY_AGENT_CONNECT_TIMEOUT_MS,
  });
  const agent = useAgent(session);
  const { messages, send } = useSessionMessages(session);
  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant({ room: session.room });
  const userSpeaking = useIsSpeaking(localParticipant);

  const rawState = session.connectionState;
  const connectionState = toVoiceConnectionState(rawState, isStarting);
  const isActive = connectionState !== 'disconnected';
  const isConnected = rawState === ConnectionState.Connected;
  const agentJoined = agent.internal.agentParticipant !== null;
  const agentFailure =
    agent.state === 'failed' ? agent.failureReasons.join(' ') || AGENT_NOT_CONNECTED_MESSAGE : null;

  const [shownFailure, setShownFailure] = useState<string | null>(null);
  if (agentFailure !== shownFailure) {
    setShownFailure(agentFailure);
    if (agentFailure !== null) setError(agentFailure);
  }

  const resetSessionState = useCallback((): void => {
    setIsStarting(false);
  }, []);

  const runAndReport = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const startOnce = useCallback(
    async (request: SessionRequest): Promise<void> => {
      const controller = new AbortController();
      startAbortRef.current = controller;
      beginStart(request, controller.signal);
      const generation = generationRef.current;
      const { room } = session;
      const mic = room.localParticipant.setMicrophoneEnabled(true, undefined, {
        preConnectBuffer: true,
      });
      void mic.then(
        () => {
          if (generationRef.current !== generation) void stopLocalAudio(room);
        },
        () => undefined,
      );
      try {
        await Promise.all([
          session.start({ signal: controller.signal, tracks: { microphone: { enabled: false } } }),
          mic.catch((e: unknown) => {
            controller.abort();
            throw e;
          }),
        ]);
      } finally {
        cancelStart();
        if (startAbortRef.current === controller) startAbortRef.current = null;
      }
    },
    [session, beginStart, cancelStart],
  );

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
        if (generation === generationRef.current) {
          if (!(e instanceof StartCancelledError)) {
            logger.error('Voice', `Connect failed: ${errorMessage(e)}`);
            setError(errorMessage(e));
          }
          generationRef.current += 1;
          await stopLocalAudio(session.room);
        }
        resetSessionState();
      }
    },
    [isActive, startOnce, resetSessionState, session.room],
  );

  const connect = useCallback((): Promise<void> => startSession(TALK_REQUEST), [startSession]);

  const endSession = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    startAbortRef.current?.abort();
    try {
      await session.end();
    } catch (e) {
      logger.error('Voice', `Disconnect failed: ${errorMessage(e)}`);
    }
    await stopLocalAudio(session.room);
  }, [session]);

  const sessionRoom = session.room;
  useEffect(
    () => () => {
      generationRef.current += 1;
      startAbortRef.current?.abort();
      void sessionRoom.disconnect();
      void stopLocalAudio(sessionRoom);
    },
    [sessionRoom],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    await endSession();
    resetSessionState();
  }, [endSession, resetSessionState]);

  const onNotificationTap = useCallback(
    (tap: NotificationTap): void => {
      void startSession({ trigger: 'notification_tap', taskInstanceId: tap.taskInstanceId });
    },
    [startSession],
  );
  usePushNotifications(onNotificationTap);

  useEffect(() => {
    session.room.on(RoomEvent.Disconnected, resetSessionState);
    return () => {
      session.room.off(RoomEvent.Disconnected, resetSessionState);
    };
  }, [session.room, resetSessionState]);

  useEffect(() => {
    if (agentFailure === null) {
      handledFailureRef.current = null;
    } else if (handledFailureRef.current !== agentFailure) {
      handledFailureRef.current = agentFailure;
      void endSession();
    }
  }, [agentFailure, endSession]);

  useEffect(() => {
    if (!isConnected) return;
    attachLogRoom(session.room);
    return detachLogRoom;
  }, [isConnected, session.room]);

  useEffect(
    () => (phone ? registerPhoneRpcMethods(session.room) : undefined),
    [phone, session.room],
  );

  const toggleMicrophone = useCallback(
    (): Promise<void> =>
      runAndReport(() => session.room.localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)),
    [runAndReport, session.room, isMicrophoneEnabled],
  );

  const sendChat = useCallback(
    (text: string): Promise<void> => runAndReport(() => send(text)),
    [runAndReport, send],
  );

  const clearError = useCallback((): void => setError(null), []);

  const voiceValue = useMemo<VoiceApi>(
    () => ({ isInteractive: isActive, connectionState, error, clearError, connect, disconnect }),
    [isActive, connectionState, error, clearError, connect, disconnect],
  );

  const conversationValue = useMemo<ConversationApi>(
    () => ({
      isMicrophoneEnabled,
      toggleMicrophone,
      userSpeaking,
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
      userSpeaking,
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

export function VoiceProvider(props: {
  pairedDevice: PairedDevice | null;
  children: ReactNode;
}): ReactElement {
  const { pairedDevice, children } = props;
  if (pairedDevice === null) {
    return <VoiceContext.Provider value={IDLE_VOICE}>{children}</VoiceContext.Provider>;
  }
  return (
    <PairedVoiceProvider phone={pairedDevice.kind === 'senior_phone'}>
      {children}
    </PairedVoiceProvider>
  );
}
