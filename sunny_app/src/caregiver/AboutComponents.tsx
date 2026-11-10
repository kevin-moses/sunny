// sunny_app/src/caregiver/AboutComponents.tsx
//
// Purpose: The building blocks of the caregiver About tab, in the Home tab's style (warm
// translucent cards, rounded type, accent selection, serious red for errors, moderate amber for
// facts that are not confirmed):
// - AboutInput: a one-paragraph text field (Return means "done", in the add forms and inline
//   editing alike) that reports its focus to the tab bar (hidden while a field has focus, since a
//   hardware keyboard fires no keyboard events), and blur on unmount only if it had focus;
// - EditableText: a text that editors tap (a 44pt target) to edit inline (autosaving, no Save or
//   Cancel; see useInlineEditor); viewers see plain text;
// - EntryRow, TopicRow, FactRow and MessageRow: one life profile entry (name and details), one
//   hard question (topic and guidance), one memory fact (with who confirmed it, or a visible "not
//   confirmed" mark and a one-tap Confirm for editors, which saves an open correction instead of
//   confirming the old text) and one family message;
// - RemoveButton: a 44pt trash button that asks for confirmation before removing (removals are
//   not undoable, so they are confirmed instead); it sets aside the row's open edit first so no
//   save is aimed at the deleted row;
// - SlotStatus: a row's or form's running, failed or notice line;
// - AddForm: the small form under each section (fields, optional category chips, an Add button
//   that is dimmed and disabled until the required fields have text and while a call runs; the
//   fields are locked while it runs and clear only once the item is stored as typed).
// Field lengths match the server's caps (profile.ts) so typing stops where the server would refuse.
//
// Last modified: 2026-11-09

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
  type SensitiveTopic,
} from './aboutFormat';
import { useReportNoteFocus } from './tabBarInset';
import type { InlineEditor } from './useInlineEditor';
import type { ProfileActionState, RemoveTarget } from './useProfileActions';

/** Longest text of each field, matching the server's caps in profile.ts. */
export const FIELD_MAX = {
  name: 120,
  details: 600,
  topic: 200,
  guidance: 1500,
  fact: 300,
  message: 1000,
} as const;

const unconfirmedTone = statusTones.moderate;
const errorTone = statusTones.serious;

/**
 * purpose: A text field in the About tab's style. Every About text is one paragraph, so Return
 *          means "done" (it closes the keyboard; a multiline field only wraps). It reports focus
 *          and blur to the tab bar, and on unmount reports blur only if it still had focus, so a
 *          field that unmounts after focus moved to another field cannot bring the tab bar back
 *          over the focused one. Other props pass through to TextInput.
 * @param props: (TextInputProps) TextInput props; onFocus and onBlur are still called.
 * @return: (JSX.Element) The field.
 */
export function AboutInput(props: TextInputProps) {
  const reportFocus = useReportNoteFocus();
  const focusedRef = useRef(false);
  const { onFocus, onBlur, style, ...rest } = props;
  useEffect(
    () => () => {
      if (focusedRef.current) reportFocus(false);
    },
    [reportFocus],
  );
  return (
    <TextInput
      returnKeyType="done"
      submitBehavior="blurAndSubmit"
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

/**
 * purpose: A text an editor taps to edit inline. When its editor is open it shows an
 *          uncontrolled field starting with the current text (or a draft that failed to save);
 *          every keystroke goes to the editor hook, and losing focus closes and saves it. With
 *          nothing to show and no editing, it renders nothing.
 * @param props: ({ target, text, placeholder, textStyle, canEdit, editor, multiline, maxLength,
 *        label }) The text being edited, what to show (null when empty), the prompt shown to
 *        editors when empty, the text style, whether this caregiver may edit, the shared inline
 *        editor, whether the field takes several lines, its length cap and its accessibility label.
 * @return: (JSX.Element | null) The text or its editor.
 */
export function EditableText({
  target,
  text,
  placeholder,
  textStyle,
  canEdit,
  editor,
  multiline = false,
  maxLength,
  label,
}: {
  target: FieldTarget;
  text: string | null;
  placeholder: string;
  textStyle: StyleProp<TextStyle>;
  canEdit: boolean;
  editor: InlineEditor;
  multiline?: boolean;
  maxLength: number;
  label: string;
}) {
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

/**
 * purpose: A row's or form's status line: a quiet "Saving..." while a call runs, the error in
 *          red, or a notice in grey. Nothing when the slot is empty.
 * @param props: ({ state: ProfileActionState | undefined }) The slot's state.
 * @return: (JSX.Element | null) The line.
 */
export function SlotStatus({ state }: { state: ProfileActionState | undefined }) {
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

/**
 * purpose: A 44pt trash button that asks "Remove <what>?" and removes the row on confirmation.
 *          Before asking it closes the row's open inline editor without saving (keeping the
 *          draft in case the removal is cancelled; the alert would otherwise blur the field and
 *          save it), and on confirmation drops the row's drafts before removing, so no save is
 *          aimed at a deleted row. Dimmed and disabled while the row has a call running.
 * @param props: ({ target, what, busy, editor, onRemove }) The row, how to name it in the
 *        question, whether a call is running, the shared inline editor, and the remove action.
 * @return: (JSX.Element) The button.
 */
export function RemoveButton({
  target,
  what,
  busy,
  editor,
  onRemove,
}: {
  target: RemoveTarget;
  what: string;
  busy: boolean;
  editor: InlineEditor;
  onRemove: (target: RemoveTarget) => Promise<boolean>;
}) {
  const rowKey = `${target.kind}:${target.id}`;

  /**
   * purpose: Hold the row's open edit, ask for confirmation, then forget the edit and remove.
   * @return: (void)
   */
  const confirm = (): void => {
    editor.hold(rowKey);
    Alert.alert(`Remove ${what}?`, 'Sunny will no longer know this.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          editor.forget(rowKey);
          void onRemove(target);
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

/** What every editable row needs: the permission, the shared editor, its state and removal. */
interface RowProps {
  canEdit: boolean;
  editor: InlineEditor;
  state: ProfileActionState | undefined;
  onRemove: (target: RemoveTarget) => Promise<boolean>;
  /** Whether a divider separates it from the row above. */
  divided: boolean;
}

/**
 * purpose: The shared frame of an editable row: the text column ending with the row's status
 *          line, the remove button for editors, and a hairline above every row but the first.
 * @param props: ({ children, row, removeTarget, what, style }) The text column, the row props,
 *        the row to remove and how to name it in the confirmation, and an extra style (a tint).
 * @return: (JSX.Element) The row.
 */
function RowFrame({
  children,
  row,
  removeTarget,
  what,
  style,
}: {
  children: ReactNode;
  row: RowProps;
  removeTarget: RemoveTarget;
  what: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.row, row.divided && styles.divider, style]}>
      <View style={styles.rowText}>
        {children}
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

/**
 * purpose: One life profile entry: its name, then its details (editors see "Add details" when
 *          there are none), each editable inline; the remove button for editors.
 * @param props: (RowProps & { entry: ProfileEntry }) The entry and the row props.
 * @return: (JSX.Element) The row.
 */
export function EntryRow({ entry, ...row }: RowProps & { entry: ProfileEntry }) {
  return (
    <RowFrame row={row} removeTarget={{ kind: 'entry', id: entry.id }} what={entry.name}>
      <EditableText
        target={{ kind: 'entryName', id: entry.id, current: entry.name }}
        text={entry.name}
        placeholder="Name"
        textStyle={type.bodyStrong}
        canEdit={row.canEdit}
        editor={row.editor}
        maxLength={FIELD_MAX.name}
        label="Name"
      />
      <EditableText
        target={{ kind: 'entryDetails', id: entry.id, current: entry.details }}
        text={entry.details}
        placeholder="Add details"
        textStyle={[type.callout, styles.secondary]}
        canEdit={row.canEdit}
        editor={row.editor}
        multiline
        maxLength={FIELD_MAX.details}
        label={`Details about ${entry.name}`}
      />
    </RowFrame>
  );
}

/**
 * purpose: One hard question: "If asked about <topic>" and the guidance, each editable inline;
 *          the remove button for editors.
 * @param props: (RowProps & { topic: SensitiveTopic }) The topic and the row props.
 * @return: (JSX.Element) The row.
 */
export function TopicRow({ topic, ...row }: RowProps & { topic: SensitiveTopic }) {
  return (
    <RowFrame
      row={row}
      removeTarget={{ kind: 'topic', id: topic.id }}
      what={`the guidance about ${topic.topic}`}
    >
      <Text style={[type.caption, styles.secondary]}>If asked about</Text>
      <EditableText
        target={{ kind: 'topic', id: topic.id, current: topic.topic }}
        text={topic.topic}
        placeholder="Topic"
        textStyle={type.bodyStrong}
        canEdit={row.canEdit}
        editor={row.editor}
        maxLength={FIELD_MAX.topic}
        label="Topic"
      />
      <EditableText
        target={{ kind: 'guidance', id: topic.id, current: topic.guidance }}
        text={topic.guidance}
        placeholder="How Sunny should answer"
        textStyle={type.callout}
        canEdit={row.canEdit}
        editor={row.editor}
        multiline
        maxLength={FIELD_MAX.guidance}
        label={`How to answer about ${topic.topic}`}
      />
    </RowFrame>
  );
}

/**
 * purpose: One memory fact: its text (editable inline; an editor's correction also confirms
 *          it) and its status line. A fact that is not confirmed has an amber tint and status,
 *          and editors get a one-tap Confirm button. Confirm tapped while the fact's text is being
 *          edited (the tap does not blur the field) saves the edit instead, since a correction
 *          confirms the fact; it confirms the stored text only when the edit changed nothing.
 *          The remove button for editors.
 * @param props: (RowProps & { fact, seniorName, onVerify }) The fact, the senior's name for the
 *        status line, the Confirm action and the row props.
 * @return: (JSX.Element) The row.
 */
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

  /**
   * purpose: Save an open correction of this fact (which confirms it), or else confirm it.
   * @return: (Promise<void>) Resolves when the confirm call settles.
   */
  const confirm = async (): Promise<void> => {
    if (!row.editor.close(fieldKey(target))) await onVerify(fact.id);
  };

  return (
    <RowFrame
      row={row}
      removeTarget={{ kind: 'fact', id: fact.id }}
      what="this fact"
      style={!fact.verified && styles.unconfirmed}
    >
      <EditableText
        target={target}
        text={fact.fact}
        placeholder="Fact"
        textStyle={type.body}
        canEdit={row.canEdit}
        editor={row.editor}
        maxLength={FIELD_MAX.fact}
        label="Fact"
      />
      <Text style={[type.caption, fact.verified ? styles.secondary : styles.unconfirmedText]}>
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

/**
 * purpose: One family message: who sent it and when (and whether a caregiver's message was
 *          seen), then the text (or a note that it is a photo or voice clip).
 * @param props: ({ message, divided }) The message (the caller's own say "You") and whether a
 *        divider separates it from the one above.
 * @return: (JSX.Element) The row.
 */
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

/**
 * purpose: The category chips of the add-entry form, each a 44pt button; the selected one is
 *          tinted with the accent.
 * @param props: ({ value, onChange }) The selected category and the change handler.
 * @return: (JSX.Element) The chips.
 */
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

/** One field of an AddForm. */
export interface AddField {
  key: string;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
  /** The form cannot be sent while a required field is blank. */
  required: boolean;
}

/**
 * purpose: The small form under a section: optional extra controls (the category chips), the
 *          fields and a button. The button is dimmed and disabled until every required field
 *          has text and while the call runs; the fields cannot be edited while the call runs (so
 *          nothing typed then is erased when it clears). The fields clear only once the item is
 *          stored as typed; otherwise they keep the text, and the slot's error or notice shows
 *          under the button.
 * @param props: ({ fields, header, buttonLabel, state, onSubmit }) The fields, the controls
 *        above them, the button label, the form's slot state and the submit action (resolves true
 *        when stored, called with the trimmed values by field key).
 * @return: (JSX.Element) The form.
 */
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
  const working = state?.status === 'working';
  const ready = fields.every((f) => !f.required || (values[f.key] ?? '').trim() !== '');

  /**
   * purpose: Send the trimmed values and clear the fields once the item is stored.
   * @return: (Promise<void>) Resolves when the call settles.
   */
  const submit = async (): Promise<void> => {
    const trimmed = Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()]));
    if (await onSubmit(trimmed)) setValues({});
  };

  return (
    <View style={styles.form}>
      {header}
      {fields.map((field) => (
        <AboutInput
          key={field.key}
          value={values[field.key] ?? ''}
          onChangeText={(text) => setValues((prev) => ({ ...prev, [field.key]: text }))}
          placeholder={field.placeholder}
          accessibilityLabel={field.placeholder}
          accessibilityState={{ disabled: working }}
          editable={!working}
          multiline={field.multiline}
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
      <SlotStatus state={state?.status === 'working' ? undefined : state} />
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
  unconfirmed: {
    backgroundColor: unconfirmedTone.background,
    borderWidth: 1,
    borderColor: unconfirmedTone.separator,
  },
  unconfirmedText: { color: unconfirmedTone.foreground },
  editable: { minHeight: 44, justifyContent: 'center' },
  prompt: { color: colors.secondaryText, fontStyle: 'italic' },
  secondary: { color: colors.secondaryText },
  error: { color: errorTone.foreground },
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
