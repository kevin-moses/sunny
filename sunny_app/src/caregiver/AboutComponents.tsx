// sunny_app/src/caregiver/AboutComponents.tsx
//
// Purpose: The building blocks of the caregiver About tab, in the Home tab's style (warm
// translucent cards, rounded type, accent selection, serious red for errors, moderate amber for
// facts that are not confirmed and for unsaved edits):
// - AboutInput: a text field that reports its focus to the tab bar (hidden while a field has
//   focus, since a hardware keyboard fires no keyboard events) and, on unmount, blur only if it
//   had focus. Return means "done" (one paragraph: details, guidance, names, facts) unless the
//   field asks for line breaks (the message field, which has its own Send button);
// - EditableText: a text that editors tap (a 44pt target) to edit inline (autosaving, no Save or
//   Cancel; see useInlineEditor); viewers see plain text;
// - EntryRow, TopicRow, FactRow and MessageRow: one life profile entry (name and details), one
//   hard question (topic and guidance), one memory fact (with who confirmed it, or a visible "not
//   confirmed" mark and a one-tap Confirm for editors) and one family message. An editable row
//   says "Unsaved edit" while it holds a draft that is not stored (a failed save, or an edit set
//   aside by Remove). Confirm saves an open correction (which confirms the fact), reopens a held
//   one, and confirms the stored text only when no other text is pending;
// - RemoveButton: a 44pt trash button that asks for confirmation before removing (removals are
//   not undoable, so they are confirmed instead); it sets the row's open edit aside first, and
//   drops it only once the removal succeeded, so a cancelled or failed removal loses nothing;
// - SlotStatus: a row's or form's running, failed or notice line;
// - AddForm: the small form under each section (fields, optional category chips, an Add button
//   that is dimmed and disabled until the required fields have text and while a call runs; the
//   fields are locked while it runs, keep their text unless the item is stored as typed, and a
//   message under the button goes away once a field is edited).
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
  rowKey,
  type RowRef,
  type SensitiveTopic,
} from './aboutFormat';
import { useReportNoteFocus } from './tabBarInset';
import type { InlineEditor } from './useInlineEditor';
import type { ProfileActionState } from './useProfileActions';

/** Longest text of each field, matching the server's caps in profile.ts. */
export const FIELD_MAX = {
  name: 120,
  details: 600,
  topic: 200,
  guidance: 1500,
  fact: 300,
  message: 1000,
} as const;

const amber = statusTones.moderate;
const red = statusTones.serious;

/**
 * purpose: A text field in the About tab's style. Return means "done" (it closes the keyboard; a
 *          multiline field only wraps) unless returnAddsLine is set, when it inserts a line break.
 *          It reports focus and blur to the tab bar, and on unmount reports blur only if it still
 *          had focus, so a field that unmounts after focus moved to another field cannot bring
 *          the tab bar back over the focused one. Other props pass through to TextInput.
 * @param props: (TextInputProps & { returnAddsLine?: boolean }) TextInput props (onFocus and
 *        onBlur are still called) and whether Return inserts a line break.
 * @return: (JSX.Element) The field.
 */
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

/** What every editable row needs: the permission, the shared editor, its state and removal. */
interface RowProps {
  canEdit: boolean;
  editor: InlineEditor;
  state: ProfileActionState | undefined;
  onRemove: (target: RowRef) => Promise<boolean>;
  /** Whether a divider separates it from the row above. */
  divided: boolean;
}

/**
 * purpose: A text an editor taps to edit inline. When its editor is open it shows an
 *          uncontrolled field starting with the current text (or a kept draft); every keystroke
 *          goes to the editor hook, and losing focus closes and saves it. Return means "done".
 *          With nothing to show and no editing, it renders nothing.
 * @param props: ({ row, target, text, placeholder, textStyle, multiline, maxLength, label }) The
 *        row's permission and editor, the text being edited, what to show (null when empty), the
 *        prompt shown to editors when empty, the text style, whether the field wraps, its length
 *        cap and its accessibility label.
 * @return: (JSX.Element | null) The text or its editor.
 */
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

/**
 * purpose: A row's or form's status line: a quiet "Saving..." while a call runs, the error in
 *          red, or a notice in grey. Nothing when the slot is empty.
 * @param props: ({ state: ProfileActionState | undefined }) The slot's state.
 * @return: (JSX.Element | null) The line.
 */
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

/**
 * purpose: A 44pt trash button that asks "Remove <what>?" and removes the row on confirmation.
 *          Before asking it sets the row's open edit aside without saving (the alert would
 *          otherwise blur the field and save it); the edit is dropped only once the removal
 *          succeeded, so after a cancel or a failure it is still there to reopen. Dimmed and
 *          disabled while the row has a call running.
 * @param props: ({ target, what, busy, editor, onRemove }) The row, how to name it in the
 *        question, whether a call is running, the shared inline editor, and the remove action
 *        (resolves true when removed).
 * @return: (JSX.Element) The button.
 */
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

  /**
   * purpose: Hold the row's open edit, ask for confirmation, then remove (and forget the edit
   *          once the removal succeeded).
   * @return: (void)
   */
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

/**
 * purpose: The shared frame of an editable row: the text column ending with an "Unsaved edit"
 *          hint while the row holds a draft that is not stored and the row's status line, the
 *          remove button for editors, and a hairline above every row but the first.
 * @param props: ({ children, row, removeTarget, what, style }) The text column, the row props,
 *        the row (for removal and its unsaved drafts) and how to name it in the confirmation,
 *        and an extra style (a tint).
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

/**
 * purpose: One memory fact: its text (editable inline; an editor's correction also confirms
 *          it) and its status line. A fact that is not confirmed has an amber tint and status,
 *          and editors get a one-tap Confirm button. Confirm tapped while the text is open (the
 *          tap does not blur it) saves the edit, since a correction confirms the fact; with a
 *          held or failed correction it reopens that draft; only otherwise does it confirm the
 *          stored text. The remove button for editors.
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
   * purpose: Settle a pending correction (save the open one, reopen a kept one), or else
   *          confirm the fact.
   * @return: (Promise<void>) Resolves when the confirm call settles.
   */
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
  /** The field wraps over several lines. */
  multiline?: boolean;
  /** Return inserts a line break instead of closing the keyboard (the message field). */
  returnAddsLine?: boolean;
  /** The form cannot be sent while a required field is blank. */
  required: boolean;
}

/**
 * purpose: The small form under a section: optional extra controls (the category chips), the
 *          fields and a button. The button is dimmed and disabled until every required field
 *          has text and while the call runs; the fields cannot be edited while the call runs (so
 *          nothing typed then is erased when it clears). The fields clear only once the item is
 *          stored as typed; otherwise they keep the text. The slot's error or notice shows under
 *          the button until a field is edited.
 * @param props: ({ fields, header, buttonLabel, state, onSubmit }) The fields, the controls
 *        above them, the button label, the form's slot state and the submit action (resolves true
 *        when stored as typed, called with the trimmed values by field key).
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
  /** The slot state the caregiver has edited past; it is not shown again. */
  const [dismissed, setDismissed] = useState<ProfileActionState | undefined>(undefined);
  const working = state?.status === 'working';
  const ready = fields.every((f) => !f.required || (values[f.key] ?? '').trim() !== '');

  /**
   * purpose: Send the trimmed values and clear the fields once the item is stored as typed.
   * @return: (Promise<void>) Resolves when the call settles.
   */
  const submit = async (): Promise<void> => {
    const trimmed = Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()]));
    if (await onSubmit(trimmed)) setValues({});
  };

  /**
   * purpose: Record an edit of one field and hide the message left by the last call.
   * @param key: (string) The field.
   * @param text: (string) Its new text.
   * @return: (void)
   */
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
