// sunny_app/src/voice/TranscriptList.tsx
//
// Purpose: Scrolling transcript for text mode. The user's words are
// right-aligned bubbles tinted with the accent color; Sunny's words are left-aligned plain
// text. Text is black at the theme body font size. VoiceOver reads "You said: ..." and
// "Sunny said: ...". The list sticks to the newest message.
//
// Last modified: 2026-10-28

import { useRef, type ReactElement } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { useConversation, type ConversationMessage } from './voiceContext';

/** Opacity of the accent tint behind the user's bubbles. */
const USER_BUBBLE_TINT = '1F';

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
  const { accentColor, bodyFontSize, cornerRadius } = useTheme();
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
        item.fromUser ? (
          <View style={styles.userRow} accessible accessibilityLabel={`You said: ${item.text}`}>
            <View
              style={[
                styles.bubble,
                {
                  borderRadius: cornerRadius,
                  backgroundColor: `${accentColor}${USER_BUBBLE_TINT}`,
                },
              ]}
            >
              <Text style={[styles.text, { fontSize: bodyFontSize }]}>{item.text}</Text>
            </View>
          </View>
        ) : (
          <View style={styles.agentRow} accessible accessibilityLabel={`Sunny said: ${item.text}`}>
            <Text style={[styles.text, styles.agentText, { fontSize: bodyFontSize }]}>
              {item.text}
            </Text>
          </View>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingVertical: 8, gap: 4 },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingLeft: 16 },
  agentRow: { flexDirection: 'row', justifyContent: 'flex-start', paddingRight: 16 },
  bubble: { paddingHorizontal: 16, paddingVertical: 8 },
  agentText: { paddingVertical: 8 },
  text: { color: colors.ink },
});
