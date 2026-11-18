import { useRef, type ReactElement } from 'react';
import { FlatList, StyleSheet } from 'react-native';

import { AgentMessage, UserBubble } from '../components/ChatMessages';
import { useConversation, type ConversationMessage } from './voiceContext';

interface TranscriptEntry {
  id: string;
  text: string;
  fromUser: boolean;
}

function toTranscriptEntry(message: ConversationMessage): TranscriptEntry | null {
  const text = message.message.trim();
  if (text === '') return null;
  const fromUser =
    message.type === 'userTranscript' ||
    ((message.type === 'chatMessage' || message.type === undefined) && !!message.from?.isLocal);
  return { id: message.id, text, fromUser };
}

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
