import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { PrimaryButton } from '../components/PrimaryButton';
import { colors, statusTones } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';
import {
  CATEGORIES,
  factStatus,
  fieldKey,
  messageMeta,
  type FamilyMessage,
  type FieldTarget,
  type LifeCategory,
  type MemoryFact,
  type ProfileEntry,
  rowKey,
  type RowRef,
  type SensitiveTopic,
} from './aboutFormat';
import type {
  MAX_DETAILS,
  MAX_FACT,
  MAX_GUIDANCE,
  MAX_MESSAGE,
  MAX_NAME,
  MAX_TOPIC,
} from '../../../sunny_backend/convex/profile';
import { useReportNoteFocus } from './tabBarInset';
import type { InlineEditor } from './useInlineEditor';
import type { ProfileActionState } from './useProfileActions';

export const FIELD_MAX: {
  name: typeof MAX_NAME;
  details: typeof MAX_DETAILS;
  topic: typeof MAX_TOPIC;
  guidance: typeof MAX_GUIDANCE;
  fact: typeof MAX_FACT;
  message: typeof MAX_MESSAGE;
} = {
  name: 120,
  details: 600,
  topic: 200,
  guidance: 1500,
  fact: 300,
  message: 1000,
};

const amber = statusTones.moderate;
const red = statusTones.serious;

export function AboutInput({
  returnAddsLine = false,
  onFocus,
  onBlur,
  style,
  ...rest
}: TextInputProps & { returnAddsLine?: boolean }) {
  const reportFocus = useReportNoteFocus();
  const focusedRef = useRef(false);
  useEffect(
    () => () => {
      if (focusedRef.current) reportFocus(false);
    },
    [reportFocus],
  );
  return (
    <TextInput
      returnKeyType={returnAddsLine ? 'default' : 'done'}
      submitBehavior={returnAddsLine ? 'newline' : 'blurAndSubmit'}
      {...rest}
      onFocus={(e) => {
        focusedRef.current = true;
        reportFocus(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        reportFocus(false);
        onBlur?.(e);
      }}
      placeholderTextColor={colors.secondaryText}
      style={[type.body, styles.input, style]}
    />
  );
}

interface RowProps {
  canEdit: boolean;
  editor: InlineEditor;
  state: ProfileActionState | undefined;
  onRemove: (target: RowRef) => Promise<boolean>;
  divided: boolean;
}

function EditableText({
  row,
  target,
  text,
  placeholder,
  textStyle,
  multiline = false,
  maxLength,
  label,
}: {
  row: Pick<RowProps, 'canEdit' | 'editor'>;
  target: FieldTarget;
  text: string | null;
  placeholder: string;
  textStyle: StyleProp<TextStyle>;
  multiline?: boolean;
  maxLength: number;
  label: string;
}) {
  const { canEdit, editor } = row;
  const key = fieldKey(target);
  if (canEdit && editor.open?.key === key) {
    return (
      <AboutInput
        autoFocus
        multiline={multiline}
        defaultValue={editor.open.initialDraft}
        onChangeText={editor.setDraft}
        onBlur={() => {
          editor.close(key);
        }}
        placeholder={placeholder}
        accessibilityLabel={label}
        maxLength={maxLength}
        style={multiline && styles.multiline}
      />
    );
  }
  if (!canEdit) {
    return text === null ? null : <Text style={textStyle}>{text}</Text>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text === null ? placeholder : `${label}: ${text}`}
      accessibilityHint="Edits this; it saves when you are done"
      onPress={() => editor.toggle(target)}
      style={({ pressed }) => [styles.editable, pressed && styles.pressed]}
    >
      <Text style={text === null ? [type.callout, styles.prompt] : textStyle}>
        {text ?? placeholder}
      </Text>
    </Pressable>
  );
}

function SlotStatus({ state }: { state: ProfileActionState | undefined }) {
  if (state === undefined) return null;
  if (state.status === 'working') {
    return <Text style={[type.caption, styles.secondary]}>Saving...</Text>;
  }
  return (
    <Text
      accessibilityRole={state.status === 'error' ? 'alert' : undefined}
      style={[type.caption, state.status === 'error' ? styles.error : styles.secondary]}
    >
      {state.message}
    </Text>
  );
}

function RemoveButton({
  target,
  what,
  busy,
  editor,
  onRemove,
}: {
  target: RowRef;
  what: string;
  busy: boolean;
  editor: InlineEditor;
  onRemove: (target: RowRef) => Promise<boolean>;
}) {
  const key = rowKey(target);

  const confirm = (): void => {
    editor.hold(key);
    Alert.alert(`Remove ${what}?`, 'Sunny will no longer know this.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void onRemove(target).then((removed) => {
            if (removed) editor.forget(key);
          });
        },
      },
    ]);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove ${what}`}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={confirm}
      style={({ pressed }) => [
        styles.iconButton,
        busy && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <SymbolView name="trash" size={18} tintColor={colors.secondaryText} />
    </Pressable>
  );
}

function RowFrame({
  children,
  row,
  removeTarget,
  what,
  style,
}: {
  children: ReactNode;
  row: RowProps;
  removeTarget: RowRef;
  what: string;
  style?: StyleProp<ViewStyle>;
}) {
  const unsaved = row.editor.unsaved.has(rowKey(removeTarget));
  return (
    <View style={[styles.row, row.divided && styles.divider, style]}>
      <View style={styles.rowText}>
        {children}
        {unsaved && (
          <Text style={[type.caption, styles.amberText]}>
            Unsaved edit. Tap the text to see it.
          </Text>
        )}
        <SlotStatus state={row.state} />
      </View>
      {row.canEdit && (
        <RemoveButton
          target={removeTarget}
          what={what}
          busy={row.state?.status === 'working'}
          editor={row.editor}
          onRemove={row.onRemove}
        />
      )}
    </View>
  );
}

export function EntryRow({ entry, ...row }: RowProps & { entry: ProfileEntry }) {
  return (
    <RowFrame row={row} removeTarget={{ kind: 'entry', id: entry.id }} what={entry.name}>
      <EditableText
        row={row}
        target={{ kind: 'entryName', id: entry.id, current: entry.name }}
        text={entry.name}
        placeholder="Name"
        textStyle={type.bodyStrong}
        maxLength={FIELD_MAX.name}
        label="Name"
      />
      <EditableText
        row={row}
        target={{ kind: 'entryDetails', id: entry.id, current: entry.details }}
        text={entry.details}
        placeholder="Add details"
        textStyle={[type.callout, styles.secondary]}
        multiline
        maxLength={FIELD_MAX.details}
        label={`Details about ${entry.name}`}
      />
    </RowFrame>
  );
}

export function TopicRow({ topic, ...row }: RowProps & { topic: SensitiveTopic }) {
  return (
    <RowFrame
      row={row}
      removeTarget={{ kind: 'topic', id: topic.id }}
      what={`the guidance about ${topic.topic}`}
    >
      <Text style={[type.caption, styles.secondary]}>If asked about</Text>
      <EditableText
        row={row}
        target={{ kind: 'topic', id: topic.id, current: topic.topic }}
        text={topic.topic}
        placeholder="Topic"
        textStyle={type.bodyStrong}
        maxLength={FIELD_MAX.topic}
        label="Topic"
      />
      <EditableText
        row={row}
        target={{ kind: 'guidance', id: topic.id, current: topic.guidance }}
        text={topic.guidance}
        placeholder="How Sunny should answer"
        textStyle={type.callout}
        multiline
        maxLength={FIELD_MAX.guidance}
        label={`How to answer about ${topic.topic}`}
      />
    </RowFrame>
  );
}

export function FactRow({
  fact,
  seniorName,
  onVerify,
  ...row
}: RowProps & {
  fact: MemoryFact;
  seniorName: string | null;
  onVerify: (id: MemoryFact['id']) => Promise<boolean>;
}) {
  const target: FieldTarget = { kind: 'fact', id: fact.id, current: fact.fact };

  const confirm = async (): Promise<void> => {
    if (!row.editor.settle(target)) await onVerify(fact.id);
  };

  return (
    <RowFrame
      row={row}
      removeTarget={{ kind: 'fact', id: fact.id }}
      what="this fact"
      style={!fact.verified && styles.unconfirmed}
    >
      <EditableText
        row={row}
        target={target}
        text={fact.fact}
        placeholder="Fact"
        textStyle={type.body}
        maxLength={FIELD_MAX.fact}
        label="Fact"
      />
      <Text style={[type.caption, fact.verified ? styles.secondary : styles.amberText]}>
        {factStatus(fact, seniorName)}
      </Text>
      {!fact.verified && row.canEdit && (
        <PrimaryButton
          compact
          label="Confirm"
          accessibilityLabel={`Confirm: ${fact.fact}`}
          accessibilityHint="Marks this fact as true so Sunny relies on it"
          disabled={row.state?.status === 'working'}
          onPress={confirm}
        />
      )}
    </RowFrame>
  );
}

export function MessageRow({ message, divided }: { message: FamilyMessage; divided: boolean }) {
  const media = message.hasPhoto ? 'A photo' : message.hasAudio ? 'A voice clip' : null;
  return (
    <View accessible style={[styles.row, styles.rowText, divided && styles.divider]}>
      <Text style={[type.caption, styles.secondary]}>{messageMeta(message)}</Text>
      {message.body !== null && <Text style={type.body}>{message.body}</Text>}
      {media !== null && <Text style={[type.callout, styles.secondary]}>{media}</Text>}
    </View>
  );
}

export function CategoryChips({
  value,
  onChange,
}: {
  value: LifeCategory;
  onChange: (category: LifeCategory) => void;
}) {
  const { accentColor } = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={styles.chips}>
      {CATEGORIES.map(({ category, chip }) => {
        const selected = category === value;
        return (
          <Pressable
            key={category}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(category)}
            style={({ pressed }) => [
              styles.chip,
              selected && { backgroundColor: `${accentColor}40`, borderColor: accentColor },
              pressed && styles.pressed,
            ]}
          >
            <Text style={type.button}>{chip}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface AddField {
  key: string;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
  returnAddsLine?: boolean;
  required: boolean;
}

export function AddForm({
  fields,
  header,
  buttonLabel,
  state,
  onSubmit,
}: {
  fields: AddField[];
  header?: ReactNode;
  buttonLabel: string;
  state: ProfileActionState | undefined;
  onSubmit: (values: Record<string, string>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<ProfileActionState | undefined>(undefined);
  const working = state?.status === 'working';
  const ready = fields.every((f) => !f.required || (values[f.key] ?? '').trim() !== '');

  const submit = async (): Promise<void> => {
    const trimmed = Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()]));
    if (await onSubmit(trimmed)) setValues({});
  };

  const edit = (key: string, text: string): void => {
    setValues((prev) => ({ ...prev, [key]: text }));
    setDismissed(state);
  };

  return (
    <View style={styles.form}>
      {header}
      {fields.map((field) => (
        <AboutInput
          key={field.key}
          value={values[field.key] ?? ''}
          onChangeText={(text) => edit(field.key, text)}
          placeholder={field.placeholder}
          accessibilityLabel={field.placeholder}
          accessibilityState={{ disabled: working }}
          editable={!working}
          multiline={field.multiline}
          returnAddsLine={field.returnAddsLine}
          maxLength={field.maxLength}
          style={field.multiline && styles.multiline}
        />
      ))}
      <PrimaryButton
        compact
        label={buttonLabel}
        busy={working}
        disabled={!ready || working}
        onPress={submit}
      />
      {!working && state !== dismissed && <SlotStatus state={state} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    minHeight: 44,
    paddingVertical: 10,
    paddingLeft: 12,
    borderRadius: 12,
  },
  rowText: { flex: 1, gap: 4, paddingRight: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  unconfirmed: { backgroundColor: amber.background, borderWidth: 1, borderColor: amber.separator },
  amberText: { color: amber.foreground },
  editable: { minHeight: 44, justifyContent: 'center' },
  prompt: { color: colors.secondaryText, fontStyle: 'italic' },
  secondary: { color: colors.secondaryText },
  error: { color: red.foreground },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.separator,
    backgroundColor: colors.surface,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  form: { gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.separator,
  },
});
