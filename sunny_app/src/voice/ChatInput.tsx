import { useState, type ReactElement } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';

import { MessageField } from '../components/MessageField';
import { useConversation } from './voiceContext';

export function ChatInput(): ReactElement {
  const { sendChat } = useConversation();
  const [text, setText] = useState('');

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
