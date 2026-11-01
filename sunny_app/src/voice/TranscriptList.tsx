// sunny_app/src/voice/TranscriptList.tsx
//
// Purpose: Scrolling transcript for text mode. The user's words are
// right-aligned bubbles tinted with the accent color; Sunny's words are left-aligned plain
// text (both are the shared UserBubble and AgentMessage). The list sticks to the newest
// message.
//
// Last modified: 2026-10-31

import { useRef, type ReactElement } from 'react';
import { FlatList, StyleSheet } from 'react-native';

import { AgentMessage, UserBubble } from '../components/ChatMessages';
import { useConversation, type ConversationMessage } from './voiceContext';

/** A message reduced to what the list shows. */
interface TranscriptEntry {
  id: string;
  text: string;
  fromUser: boolean;
}

/**
 * purpose: Convert a session message into a transcript entry, dropping empty text.
 * @param message: (ConversationMessage) a transcript or chat message
 * @return: (TranscriptEntry | null) the entry, or null when there is no text to show
 */
function toTranscriptEntry(message: ConversationMessage): TranscriptEntry | null {
  const text = message.message.trim();
  if (text === '') return null;
  const fromUser =
    message.type === 'userTranscript' ||
    ((message.type === 'chatMessage' || message.type === undefined) && !!message.from?.isLocal);
  return { id: message.id, text, fromUser };
}

/**
 * purpose: Render the conversation transcript.
 * @return: (ReactElement) the message list
 */
export function TranscriptList(): ReactElement {
  const { messages } = useConversation();
  const listRef = useRef<FlatList<TranscriptEntry>>(null);
  const entries = messages.map(toTranscriptEntry).filter((e): e is TranscriptEntry => e !== null);

  return (
    <FlatList
      ref={listRef}
      data={entries}
      keyExtractor={(entry) => entry.id}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      renderItem={({ item }) =>
        item.fromUser ? <UserBubble text={item.text} /> : <AgentMessage text={item.text} />
      }
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingVertical: 8, gap: 4 },
});
