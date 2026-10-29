// sunny_app/src/voice/ConversationScreen.tsx
//
// Purpose: The live conversation screen shown while a voice session is interactive. It
// owns the interaction mode (voice or text), which starts as voice for every conversation.
//   Voice mode: the agent bar visualizer fills the screen and the "Agent is listening, start
//     talking" hint shows until the first transcript arrives.
//   Text mode: a compact visualizer above the transcript list and a message input.
// The ControlBar sits at the bottom, hidden while the text keyboard is open.
// Error and reconnecting banners are owned by the app shell, not this screen.
//
// Last modified: 2026-10-28

import { useEffect, useState, type ReactElement } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BACKGROUND } from '../theme/colors';
import { AgentListeningHint } from './AgentListeningHint';
import { AgentVisualizer } from './AgentVisualizer';
import { ChatInput } from './ChatInput';
import { ControlBar } from './ControlBar';
import { TranscriptList } from './TranscriptList';
import { useConversation } from './voiceContext';

/** Whether the conversation shows the voice visualizer or the text transcript. */
type InteractionMode = 'voice' | 'text';

/**
 * purpose: Track whether the software keyboard is showing.
 * @return: (boolean) true while the keyboard is visible
 */
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/**
 * purpose: Render the conversation for the current interaction mode.
 * @return: (ReactElement) the full-screen conversation
 */
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
