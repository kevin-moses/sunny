// sunny_app/src/voice/voiceContext.ts
//
// Purpose: Context objects and hooks that expose the voice session to the UI. useVoice()
// is the small surface the rest of the app needs (connect, disconnect, status, error).
// useConversation() carries the extra state ConversationScreen needs: microphone state,
// agent state and audio tracks, and the transcript. Both are provided by VoiceProvider
// (VoiceProvider.tsx re-exports useVoice for the app).
//
// Last modified: 2026-10-28

import type {
  AgentState,
  TrackReference,
  UseSessionMessagesReturn,
} from '@livekit/components-react';
import { createContext, useContext } from 'react';

/** Connection state exposed to the app. */
export type VoiceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** One transcript or chat entry. */
export type ConversationMessage = UseSessionMessagesReturn['messages'][number];

/** The public voice surface: what the app shell and the Talk button use. */
export interface VoiceApi {
  isInteractive: boolean;
  connectionState: VoiceConnectionState;
  error: string | null;
  clearError: () => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

/** The state and actions ConversationScreen renders. */
export interface ConversationApi {
  isMicrophoneEnabled: boolean;
  toggleMicrophone: () => Promise<void>;
  /** True once the agent participant is in the room. */
  agentJoined: boolean;
  agentState: AgentState;
  agentAudioTrack: TrackReference | undefined;
  localAudioTrack: TrackReference | undefined;
  messages: ConversationMessage[];
  sendChat: (text: string) => Promise<void>;
}

/** Context carrying the VoiceApi; provided by VoiceProvider. */
export const VoiceContext = createContext<VoiceApi | null>(null);
/** Context carrying the ConversationApi; provided by VoiceProvider for a paired device. */
export const ConversationContext = createContext<ConversationApi | null>(null);

/**
 * purpose: Read the voice API; must be used under VoiceProvider.
 * @return: (VoiceApi) connect, disconnect, status and error handling
 */
export function useVoice(): VoiceApi {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside VoiceProvider');
  return value;
}

/**
 * purpose: Read the conversation state; must be used under VoiceProvider.
 * @return: (ConversationApi) microphone, agent and transcript state with actions
 */
export function useConversation(): ConversationApi {
  const value = useContext(ConversationContext);
  if (!value) throw new Error('useConversation must be used inside VoiceProvider');
  return value;
}
