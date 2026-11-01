// sunny_app/src/voice/ChatInput.tsx
//
// Purpose: Text-mode message field with a send button. Submitting (return key or the arrow
// button) sends the text to the agent as a chat message and clears the field. The send button
// is disabled while the field is empty. The field itself is the shared MessageField.
//
// Last modified: 2026-10-31

import { useState, type ReactElement } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';

import { MessageField } from '../components/MessageField';
import { useConversation } from './voiceContext';

/**
 * purpose: Render the chat text field and send button.
 * @return: (ReactElement) the input row
 */
export function ChatInput(): ReactElement {
  const { sendChat } = useConversation();
  const [text, setText] = useState('');

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
    <View style={styles.margins}>
      <MessageField value={text} onChangeText={setText} onSend={submit} placeholder="Message" />
    </View>
  );
}

const styles = StyleSheet.create({
  margins: { marginHorizontal: 16, marginBottom: 16 },
});
