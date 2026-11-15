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
import { useWordingPlayer, type WordingPlayer } from './useWordingPlayer';
import { WordingCard } from './WordingCard';

const TRANSCRIPT_LIMIT = 20;

const EMPTY: TranscriptEntry[] = [];

interface CaregiverChatScreenProps {
  householdId: HouseholdId;
  seniorName: string | null;
  canSend: boolean;
  userId: string | null;
  active?: boolean;
}

function TranscriptRow({ entry, player }: { entry: TranscriptEntry; player: WordingPlayer }) {
  const textStyle = [type.body, styles.ink];
  if (entry.wording !== null) {
    const { sentence } = entry.wording;
    return (
      <WordingCard
        wording={entry.wording}
        playing={player.playingId === entry.id}
        failed={player.failedId === entry.id}
        onToggle={() => {
          if (sentence !== null) player.toggle(entry.id, sentence);
        }}
      />
    );
  }
  if (entry.kind === 'caregiver') {
    return (
      <UserBubble text={entry.text} textStyle={textStyle} inset={48} speaker={entry.speaker} />
    );
  }
  if (entry.kind === 'sunny') {
    return <AgentMessage text={entry.text} textStyle={textStyle} inset={32} label={entry.label} />;
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

export function CaregiverChatScreen({
  householdId,
  seniorName,
  canSend,
  userId,
  active = true,
}: CaregiverChatScreenProps) {
  const player = useWordingPlayer(active);
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const scrollRef = useRef<ScrollView>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const result = useQueryWithStatus(api.agentRequests.transcript, {
    householdId,
    limit: TRANSCRIPT_LIMIT,
  });
  const entries = useMemo(
    () => (result.data === undefined ? EMPTY : buildTranscript(result.data, userId)),
    [result.data, userId],
  );
  const busy = result.data !== undefined && hasInProgress(result.data);
  const listError = result.status === 'error' ? toBackendError(result.error).message : null;

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
        {entries.length === 0 && result.status !== 'pending' && (
          <Text style={[type.callout, styles.empty]}>
            {canSend
              ? "Ask how the day is going, or what's on the calendar."
              : "Sunny's daily summaries will show here."}
          </Text>
        )}
        {entries.map((entry) => (
          <TranscriptRow key={entry.id} entry={entry} player={player} />
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
            Viewers can read the week and Sunny&apos;s daily summaries but cannot message Sunny.
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
