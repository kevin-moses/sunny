import { useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toBackendError } from '../backend/api';
import { useQueryWithStatus } from '../backend/convex';
import { api, type HouseholdId } from '../backend/convexApi';
import { colors } from '../theme/colors';
import { type } from '../theme/typography';
import {
  AddForm,
  type AddField,
  CategoryChips,
  EntryRow,
  FactRow,
  FIELD_MAX,
  MessageRow,
  TopicRow,
} from './AboutComponents';
import { groupEntries, olderUnverifiedLine, rowKey, type LifeCategory } from './aboutFormat';
import { ScreenHeader, SectionTitle } from './CaregiverComponents';
import { useTabBarInset } from './tabBarInset';
import { useInlineEditor } from './useInlineEditor';
import { useProfileActions, type ProfileActions } from './useProfileActions';

interface CaregiverAboutScreenProps {
  householdId: HouseholdId;
  seniorName: string | null;
  canEdit: boolean;
}

const ENTRY_FIELDS: AddField[] = [
  {
    key: 'name',
    placeholder: 'Name, for example Sarah',
    maxLength: FIELD_MAX.name,
    required: true,
  },
  {
    key: 'details',
    placeholder: 'Details, for example her daughter, lives nearby',
    maxLength: FIELD_MAX.details,
    multiline: true,
    required: false,
  },
];

const TOPIC_FIELDS: AddField[] = [
  { key: 'topic', placeholder: 'If asked about...', maxLength: FIELD_MAX.topic, required: true },
  {
    key: 'guidance',
    placeholder: 'How Sunny should answer',
    maxLength: FIELD_MAX.guidance,
    multiline: true,
    required: true,
  },
];

const FACT_FIELDS: AddField[] = [
  {
    key: 'fact',
    placeholder: 'Something Sunny should know',
    maxLength: FIELD_MAX.fact,
    required: true,
  },
];

function messageFields(name: string): AddField[] {
  return [
    {
      key: 'body',
      placeholder: `A message for ${name}`,
      maxLength: FIELD_MAX.message,
      multiline: true,
      returnAddsLine: true,
      required: true,
    },
  ];
}

interface Loaded<T> {
  data: T | undefined;
  error: string | null;
}

function loaded<T>(result: { data: T | undefined; status: string; error?: unknown }): Loaded<T> {
  return {
    data: result.data,
    error: result.status === 'error' ? toBackendError(result.error).message : null,
  };
}

function Section<T extends unknown[]>({
  title,
  state,
  emptyText,
  children,
  form,
}: {
  title: string;
  state: Loaded<T>;
  emptyText: string;
  children: (data: T) => ReactNode;
  form: ReactNode;
}) {
  let body: ReactNode;
  if (state.data !== undefined) {
    body =
      state.data.length === 0 ? (
        <Text style={[type.callout, styles.emptyLine]}>{emptyText}</Text>
      ) : (
        children(state.data)
      );
  } else if (state.error !== null) {
    body = <Text style={[type.callout, styles.errorLine]}>{state.error}</Text>;
  } else {
    body = <ActivityIndicator color={colors.secondaryText} style={styles.spinner} />;
  }
  return (
    <View style={styles.section}>
      <SectionTitle text={title} />
      <View style={styles.card}>
        {body}
        {form}
      </View>
    </View>
  );
}

function AddEntryForm({ actions }: { actions: ProfileActions }) {
  const [category, setCategory] = useState<LifeCategory>('person');
  return (
    <AddForm
      header={<CategoryChips value={category} onChange={setCategory} />}
      fields={ENTRY_FIELDS}
      buttonLabel="Add"
      state={actions.states['add:entry']}
      onSubmit={(v) =>
        actions.addEntry({ category, name: v.name, details: v.details || undefined })
      }
    />
  );
}

export function CaregiverAboutScreen({
  householdId,
  seniorName,
  canEdit,
}: CaregiverAboutScreenProps) {
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const actions = useProfileActions(householdId);
  const editor = useInlineEditor(actions.saveField);
  const args = { householdId };
  const entries = loaded(useQueryWithStatus(api.profile.listEntries, args));
  const topics = loaded(useQueryWithStatus(api.profile.listTopics, args));
  const memory = loaded(useQueryWithStatus(api.profile.listMemory, args));
  const messages = loaded(useQueryWithStatus(api.profile.listMessages, args));
  const facts = { data: memory.data?.facts, error: memory.error };
  const olderUnverified = memory.data?.olderUnverified ?? 0;
  const name = seniorName ?? 'them';
  const rowProps = { canEdit, editor, onRemove: actions.remove };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 8, paddingBottom: tabBarInset },
      ]}
    >
      <ScreenHeader
        title={seniorName === null ? 'About' : `About ${seniorName}`}
        subtitle="What Sunny knows when you talk"
      />
      {!canEdit && (
        <Text style={[type.callout, styles.note]}>Viewers can read this but cannot change it.</Text>
      )}
      <Section
        title="People and places"
        state={entries}
        emptyText={`Add the people, places and routines Sunny should know about ${name}.`}
        form={canEdit && <AddEntryForm actions={actions} />}
      >
        {(data) =>
          groupEntries(data).map((group) => (
            <View key={group.category} style={styles.group}>
              <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
                {group.title}
              </Text>
              {group.entries.map((entry, i) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  state={actions.states[rowKey({ kind: 'entry', id: entry.id })]}
                  divided={i > 0}
                  {...rowProps}
                />
              ))}
            </View>
          ))
        }
      </Section>
      <Section
        title="Hard questions"
        state={topics}
        emptyText="Tell Sunny how to answer questions that are hard to answer, such as about someone who has died."
        form={
          canEdit && (
            <AddForm
              fields={TOPIC_FIELDS}
              buttonLabel="Add"
              state={actions.states['add:topic']}
              onSubmit={(v) => actions.addTopic({ topic: v.topic, guidance: v.guidance })}
            />
          )
        }
      >
        {(data) =>
          data.map((topic, i) => (
            <TopicRow
              key={topic.id}
              topic={topic}
              state={actions.states[rowKey({ kind: 'topic', id: topic.id })]}
              divided={i > 0}
              {...rowProps}
            />
          ))
        }
      </Section>
      <Section
        title="What Sunny remembers"
        state={facts}
        emptyText={`Nothing yet. Facts ${name} mentions to Sunny show up here for you to confirm.`}
        form={
          canEdit && (
            <AddForm
              fields={FACT_FIELDS}
              buttonLabel="Add"
              state={actions.states['add:fact']}
              onSubmit={(v) => actions.addFact(v.fact)}
            />
          )
        }
      >
        {(data) => (
          <>
            {data.map((fact, i) => (
              <FactRow
                key={fact.id}
                fact={fact}
                seniorName={seniorName}
                onVerify={actions.verifyFact}
                state={actions.states[rowKey({ kind: 'fact', id: fact.id })]}
                divided={i > 0}
                {...rowProps}
              />
            ))}
            {olderUnverified > 0 && (
              <Text style={[type.callout, styles.emptyLine]}>
                {olderUnverifiedLine(olderUnverified, name)}
              </Text>
            )}
          </>
        )}
      </Section>
      <Section
        title="Messages"
        state={messages}
        emptyText={`No messages yet. A message you send here is something Sunny can read to ${name}.`}
        form={
          canEdit && (
            <AddForm
              fields={messageFields(name)}
              buttonLabel="Send"
              state={actions.states['add:message']}
              onSubmit={(v) => actions.sendMessage(v.body)}
            />
          )
        }
      >
        {(data) =>
          [...data]
            .reverse()
            .map((message, i) => <MessageRow key={message.id} message={message} divided={i > 0} />)
        }
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, gap: 32 },
  section: { gap: 12 },
  card: { gap: 4, padding: 8, borderRadius: 18, backgroundColor: colors.overlayMedium },
  group: { gap: 2 },
  groupTitle: { paddingTop: 4, paddingHorizontal: 12 },
  emptyLine: { color: colors.secondaryText, paddingHorizontal: 12, paddingVertical: 8 },
  errorLine: { color: colors.seriousForeground, paddingHorizontal: 12, paddingVertical: 8 },
  spinner: { paddingVertical: 12 },
  note: { color: colors.secondaryText, marginTop: -16 },
});
