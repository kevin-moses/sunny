// sunny_app/src/caregiver/CaregiverChatScreen.tsx
//
// Purpose: The caregiver Chat tab: a conversation with the household's agent. The transcript is
// the household's agent requests (agentRequests.list, newest first) shown oldest first: the
// caregiver's message as a right-aligned accent bubble, Sunny's reply as plain text on the
// left (the shared UserBubble and AgentMessage), a calm "working" line while a request is
// queued or running, and the error when it failed. Sending calls agentRequests.request with
// continueLatest, so the server keeps the one household conversation going. Sending waits while
// any request is queued or running (the server allows one at a time per conversation). Viewers
// cannot send (the server requires an editor), so they see a note instead of the input and the
// list query is skipped. The draft text lives in the composer, so typing does not re-render the
// transcript. The screen is keyboard-aware, sticks to the newest message, and leaves room for
// the tab bar (useTabBarInset). The transcript is shared by every editor: messages from other
// caregivers carry their name above the bubble (the signed-in caregiver's id comes from
// CaregiverApp). Sends are guarded by a ref so two taps in one frame cannot both send.
//
// Last modified: 2026-10-31

import { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { callMutation, toBackendError } from '../backend/api';
import { useQueryWithStatus } from '../backend/convex';
import { api, type HouseholdId } from '../backend/convexApi';
import { AgentMessage, UserBubble } from '../components/ChatMessages';
import { MessageField } from '../components/MessageField';
import { colors } from '../theme/colors';
import { type } from '../theme/typography';
import { ScreenHeader } from './CaregiverComponents';
import { buildTranscript, hasInProgress, type TranscriptEntry } from './format';
import { useTabBarInset } from './tabBarInset';

/** How many recent requests the transcript loads. */
const REQUEST_LIMIT = 20;

/** The transcript before the first load or for a viewer. */
const EMPTY: TranscriptEntry[] = [];

/** Props for CaregiverChatScreen. */
interface CaregiverChatScreenProps {
  householdId: HouseholdId;
  /** The senior's preferred name; null before the day view has loaded. */
  seniorName: string | null;
  /** Whether this caregiver may message the agent (everyone but viewers). */
  canSend: boolean;
  /** The signed-in caregiver's Clerk user id, to tell their messages from other caregivers'. */
  userId: string | null;
}

/**
 * purpose: One line of the transcript.
 * @param props: ({ entry: TranscriptEntry }) The line.
 * @return: (JSX.Element) The bubble, reply or status line.
 */
function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const textStyle = [type.body, styles.ink];
  if (entry.kind === 'caregiver') {
    return (
      <UserBubble text={entry.text} textStyle={textStyle} inset={48} speaker={entry.speaker} />
    );
  }
  if (entry.kind === 'sunny') {
    return <AgentMessage text={entry.text} textStyle={textStyle} inset={32} />;
  }
  return (
    <View accessible accessibilityLabel={entry.text} style={styles.statusRow}>
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
 * purpose: The message field and send button, owning the draft text so typing re-renders only
 *          this component.
 * @param props: ({ placeholder, disabled, onSend }) The placeholder, whether sending is
 *        blocked, and the send function, which resolves true when the message was sent.
 * @return: (JSX.Element) The input row.
 */
function ChatComposer({
  placeholder,
  disabled,
  onSend,
}: {
  placeholder: string;
  disabled: boolean;
  onSend: (message: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');

  /**
   * purpose: Send the trimmed draft and clear it once it was sent.
   * @return: (Promise<void>) Resolves when the send settles.
   */
  const submit = async (): Promise<void> => {
    const message = text.trim();
    if (message === '') return;
    if (await onSend(message)) setText('');
  };

  return (
    <MessageField
      value={text}
      onChangeText={setText}
      onSend={() => void submit()}
      disabled={disabled}
      placeholder={placeholder}
      inputStyle={type.body}
    />
  );
}

/**
 * purpose: Render the Chat tab.
 * @param props: (CaregiverChatScreenProps) The household, the senior's name, whether the
 *        caregiver may send and the signed-in caregiver's user id.
 * @return: (JSX.Element) The screen.
 */
export function CaregiverChatScreen({
  householdId,
  seniorName,
  canSend,
  userId,
}: CaregiverChatScreenProps) {
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const scrollRef = useRef<ScrollView>(null);
  const [sending, setSending] = useState(false);
  // Synchronous in-flight guard: state is stale until the next render, so two taps in one frame
  // would both pass a state check.
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const result = useQueryWithStatus(
    api.agentRequests.list,
    canSend ? { householdId, limit: REQUEST_LIMIT } : 'skip',
  );
  const entries = useMemo(
    () => (result.data === undefined ? EMPTY : buildTranscript(result.data, userId)),
    [result.data, userId],
  );
  const busy = result.data !== undefined && hasInProgress(result.data);
  const listError = result.status === 'error' ? toBackendError(result.error).message : null;

  /**
   * purpose: Send a message to the agent, continuing the household's conversation. Only one
   *          send runs at a time; an error is shown above the input on failure.
   * @param message: (string) The trimmed, non-empty message.
   * @return: (Promise<boolean>) True when the message was sent; never rejects.
   */
  const send = async (message: string): Promise<boolean> => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      await callMutation(api.agentRequests.request, {
        householdId,
        message,
        continueLatest: true,
      });
      return true;
    } catch (e) {
      setSendError(toBackendError(e).message);
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const subtitle =
    seniorName === null ? 'Ask Sunny about the day' : `Ask Sunny about ${seniorName}'s day`;
  const placeholder = seniorName === null ? 'Ask Sunny' : `Ask Sunny about ${seniorName}`;
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
      <View style={[styles.footer, { paddingBottom: Math.max(tabBarInset, 8) }]}>
        {errorText !== null && (
          <Text accessibilityRole="alert" style={[type.callout, styles.error]}>
            {errorText}
          </Text>
        )}
        {canSend ? (
          <ChatComposer placeholder={placeholder} disabled={sending || busy} onSend={send} />
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
  statusRow: { flexDirection: 'row', paddingVertical: 8, paddingRight: 32 },
  ink: { color: colors.ink },
  empty: { color: colors.secondaryText, paddingVertical: 8 },
  footer: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  error: { color: colors.seriousForeground },
  note: { color: colors.secondaryText, paddingVertical: 12 },
});
