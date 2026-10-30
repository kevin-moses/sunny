// sunny_app/src/caregiver/CaregiverChatScreen.tsx
//
// Purpose: The caregiver Chat tab: a conversation with the household's agent. The transcript is
// the household's agent requests (agentRequests.list, newest first) shown oldest first: the
// caregiver's message as a right-aligned accent bubble, Sunny's reply as plain text on the
// left, a calm "working" line while a request is queued or running, and the error when it
// failed. Sending calls agentRequests.request, continuing the newest succeeded request so the
// agent keeps context. Viewers cannot send (the server requires an editor), so they see a note
// instead of the input and the list query is skipped. The screen is keyboard-aware, sticks to
// the newest message, and drops the tab bar clearance while the keyboard is open.
//
// Last modified: 2026-10-30

import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { callMutation, toBackendError } from '../backend/api';
import { useQueryWithStatus } from '../backend/convex';
import { api, type HouseholdId } from '../backend/convexApi';
import { colors, ROUNDED_FONT } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { ScreenHeader } from './CaregiverComponents';
import { buildTranscript, chooseContinueRequestId, type TranscriptEntry } from './format';
import { tabBarClearance, type } from './typography';

/** How many recent requests the transcript loads. */
const REQUEST_LIMIT = 20;

/** Props for CaregiverChatScreen. */
interface CaregiverChatScreenProps {
  householdId: HouseholdId;
  /** The senior's preferred name; null before the day view has loaded. */
  seniorName: string | null;
  /** Whether this caregiver may message the agent (everyone but viewers). */
  canSend: boolean;
}

/**
 * purpose: Whether the on-screen keyboard is showing.
 * @return: (boolean) True between the keyboard starting to show and starting to hide.
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
 * purpose: One line of the transcript.
 * @param props: ({ entry: TranscriptEntry }) The line.
 * @return: (JSX.Element) The bubble, reply or status line.
 */
function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const { accentColor, cornerRadius } = useTheme();
  if (entry.kind === 'caregiver') {
    return (
      <View accessible accessibilityLabel={`You said: ${entry.text}`} style={styles.caregiverRow}>
        <View
          style={[
            styles.bubble,
            { borderRadius: cornerRadius, backgroundColor: `${accentColor}1F` },
          ]}
        >
          <Text style={[type.body, styles.ink]}>{entry.text}</Text>
        </View>
      </View>
    );
  }
  if (entry.kind === 'sunny') {
    return (
      <View accessible accessibilityLabel={`Sunny said: ${entry.text}`} style={styles.sunnyRow}>
        <Text style={[type.body, styles.ink]}>{entry.text}</Text>
      </View>
    );
  }
  return (
    <View accessible accessibilityLabel={entry.text} style={styles.sunnyRow}>
      <Text
        style={[
          type.callout,
          { color: entry.kind === 'error' ? colors.seriousForeground : colors.secondaryText },
        ]}
      >
        {entry.text}
      </Text>
    </View>
  );
}

/**
 * purpose: The message field and send button.
 * @param props: ({ placeholder, value, sending, onChangeText, onSend }) The field's text and
 *        state; the send button is dimmed while the field is empty or a send is in flight.
 * @return: (JSX.Element) The input row.
 */
function ChatComposer({
  placeholder,
  value,
  sending,
  onChangeText,
  onSend,
}: {
  placeholder: string;
  value: string;
  sending: boolean;
  onChangeText: (text: string) => void;
  onSend: () => void;
}) {
  const { accentColor } = useTheme();
  const disabled = sending || value.trim() === '';
  return (
    <View style={styles.composer}>
      <TextInput
        style={[type.body, styles.input]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.secondaryText}
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={onSend}
        editable={!sending}
        accessibilityLabel={placeholder}
      />
      <Pressable
        onPress={onSend}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Send message"
        style={[styles.send, { backgroundColor: accentColor, opacity: disabled ? 0.4 : 1 }]}
      >
        <SymbolView name="arrow.up" size={24} tintColor={colors.onAccent} weight="semibold" />
      </Pressable>
    </View>
  );
}

/**
 * purpose: Render the Chat tab.
 * @param props: (CaregiverChatScreenProps) The household, the senior's name and whether the
 *        caregiver may send.
 * @return: (JSX.Element) The screen.
 */
export function CaregiverChatScreen({
  householdId,
  seniorName,
  canSend,
}: CaregiverChatScreenProps) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const scrollRef = useRef<ScrollView>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const result = useQueryWithStatus(
    api.agentRequests.list,
    canSend ? { householdId, limit: REQUEST_LIMIT } : 'skip',
  );
  const requests = useMemo(() => result.data ?? [], [result.data]);
  const entries = useMemo(() => buildTranscript(requests), [requests]);
  const listError = result.status === 'error' ? toBackendError(result.error).message : null;

  /**
   * purpose: Send the typed message to the agent, continuing the newest finished request.
   *          Only one send runs at a time; the field is cleared on success and an error is
   *          shown above the input on failure.
   * @return: (Promise<void>) Resolves when the send settles; never rejects.
   */
  const send = async (): Promise<void> => {
    const message = text.trim();
    if (sending || message === '') return;
    setSending(true);
    setSendError(null);
    try {
      await callMutation(api.agentRequests.request, {
        householdId,
        message,
        continueRequestId: chooseContinueRequestId(requests),
      });
      setText('');
    } catch (e) {
      setSendError(toBackendError(e).message);
    } finally {
      setSending(false);
    }
  };

  const name = seniorName ?? 'the day';
  const subtitle =
    seniorName === null ? 'Ask Sunny about the day' : `Ask Sunny about ${name}'s day`;
  const placeholder = seniorName === null ? 'Ask Sunny' : `Ask Sunny about ${name}`;
  const errorText = sendError ?? listError;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <ScreenHeader title="Chat" subtitle={subtitle} />
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.fill}
        contentContainerStyle={styles.transcript}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {entries.length === 0 && result.status !== 'pending' && canSend && (
          <Text style={[type.callout, styles.empty]}>
            Ask how the day is going, or what&apos;s on the calendar.
          </Text>
        )}
        {entries.map((entry) => (
          <TranscriptRow key={entry.id} entry={entry} />
        ))}
      </ScrollView>
      <View
        style={[
          styles.footer,
          { paddingBottom: keyboardVisible ? 8 : tabBarClearance(insets.bottom) },
        ]}
      >
        {errorText !== null && (
          <Text accessibilityRole="alert" style={[type.callout, styles.error]}>
            {errorText}
          </Text>
        )}
        {canSend ? (
          <ChatComposer
            placeholder={placeholder}
            value={text}
            sending={sending}
            onChangeText={setText}
            onSend={() => void send()}
          />
        ) : (
          <Text style={[type.callout, styles.note]}>
            Viewers can read the week but cannot message Sunny.
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  header: { paddingHorizontal: 24 },
  transcript: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  caregiverRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingLeft: 48 },
  sunnyRow: { flexDirection: 'row', paddingVertical: 8, paddingRight: 32 },
  bubble: { paddingHorizontal: 16, paddingVertical: 8 },
  ink: { color: colors.ink },
  empty: { color: colors.secondaryText, paddingVertical: 8 },
  footer: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  error: { color: colors.seriousForeground },
  note: { color: colors.secondaryText, paddingVertical: 12 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 12,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: colors.card,
  },
  input: { flex: 1, paddingVertical: 0, fontFamily: ROUNDED_FONT },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
