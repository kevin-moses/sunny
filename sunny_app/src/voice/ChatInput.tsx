// sunny_app/src/voice/ChatInput.tsx
//
// Purpose: Text-mode message field with a send button. Submitting (return key or the arrow
// button) sends the text to the agent as a chat message and clears the field. The send button is disabled while the field is empty.
//
// Last modified: 2026-10-28

import { SymbolView } from 'expo-symbols';
import { useState, type ReactElement } from 'react';
import { Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { useConversation } from './voiceContext';

/**
 * purpose: Render the chat text field and send button.
 * @return: (ReactElement) the input row
 */
export function ChatInput(): ReactElement {
  const { accentColor, bodyFontSize } = useTheme();
  const { sendChat } = useConversation();
  const [text, setText] = useState('');
  const canSend = text.trim() !== '';

  /**
   * purpose: Send the current text and clear the field.
   * @return: (void)
   */
  const submit = (): void => {
    const message = text.trim();
    if (message === '') return;
    setText('');
    Keyboard.dismiss();
    void sendChat(message);
  };

  return (
    <View style={styles.row}>
      <TextInput
        style={[styles.input, { fontSize: bodyFontSize }]}
        value={text}
        onChangeText={setText}
        placeholder="Message"
        placeholderTextColor={colors.secondaryText}
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={submit}
        accessibilityLabel="Message"
      />
      <Pressable
        onPress={submit}
        disabled={!canSend}
        accessibilityRole="button"
        accessibilityLabel="Send message"
        style={[styles.send, { backgroundColor: accentColor, opacity: canSend ? 1 : 0.4 }]}
      >
        <SymbolView name="arrow.up" size={24} tintColor={colors.onAccent} weight="semibold" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    marginHorizontal: 16,
    marginBottom: 16,
    paddingLeft: 16,
    paddingRight: 12,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: colors.card,
  },
  input: { flex: 1, color: colors.text, paddingVertical: 0 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
