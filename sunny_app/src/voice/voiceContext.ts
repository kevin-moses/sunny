import type {
  AgentState,
  TrackReference,
  UseSessionMessagesReturn,
} from '@livekit/components-react';
import { createContext, useContext } from 'react';

export type VoiceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type ConversationMessage = UseSessionMessagesReturn['messages'][number];

export interface VoiceApi {
  isInteractive: boolean;
  connectionState: VoiceConnectionState;
  error: string | null;
  clearError: () => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export interface ConversationApi {
  isMicrophoneEnabled: boolean;
  toggleMicrophone: () => Promise<void>;
  userSpeaking: boolean;
  agentJoined: boolean;
  agentState: AgentState;
  agentAudioTrack: TrackReference | undefined;
  localAudioTrack: TrackReference | undefined;
  messages: ConversationMessage[];
  sendChat: (text: string) => Promise<void>;
}

export const VoiceContext = createContext<VoiceApi | null>(null);
export const ConversationContext = createContext<ConversationApi | null>(null);

export function useVoice(): VoiceApi {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside VoiceProvider');
  return value;
}

export function useConversation(): ConversationApi {
  const value = useContext(ConversationContext);
  if (!value) throw new Error('useConversation must be used inside VoiceProvider');
  return value;
}
