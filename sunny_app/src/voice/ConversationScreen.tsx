import { useState, type ReactElement } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BACKGROUND } from '../theme/colors';
import { useKeyboardVisible } from '../theme/useKeyboardVisible';
import { AgentListeningHint } from './AgentListeningHint';
import { AgentVisualizer } from './AgentVisualizer';
import { ChatInput } from './ChatInput';
import { ControlBar } from './ControlBar';
import { TranscriptList } from './TranscriptList';
import { useConversation } from './voiceContext';

type InteractionMode = 'voice' | 'text';

export function ConversationScreen(): ReactElement {
  const insets = useSafeAreaInsets();
  const { messages } = useConversation();
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('voice');
  const keyboardVisible = useKeyboardVisible();
  const isText = interactionMode === 'text';

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior="padding"
      accessibilityViewIsModal
    >
      {isText ? (
        <Pressable style={styles.textArea} onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.compactAgent}>
            <AgentVisualizer />
          </View>
          <TranscriptList />
        </Pressable>
      ) : (
        <View style={styles.voiceArea}>
          <AgentVisualizer />
          {messages.length === 0 ? (
            <View style={styles.hint}>
              <AgentListeningHint />
            </View>
          ) : null}
        </View>
      )}
      {isText ? <ChatInput /> : null}
      {keyboardVisible ? null : (
        <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <ControlBar
            isText={isText}
            onToggleMode={() => setInteractionMode(isText ? 'voice' : 'text')}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BACKGROUND },
  voiceArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', bottom: 24, left: 16, right: 16, alignItems: 'center' },
  textArea: { flex: 1 },
  compactAgent: { height: 100, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  controls: { paddingTop: 8 },
});
