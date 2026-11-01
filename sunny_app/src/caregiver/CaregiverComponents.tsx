// sunny_app/src/caregiver/CaregiverComponents.tsx
//
// Purpose: The building blocks of the caregiver Home tab: the screen header (title, subtitle
// and optional trailing control), the section title, the calendar card with its seven-day week
// strip (tappable cells that select a day), the alert card with its "I'm on it" and "Mark done"
// actions (or who is already on it), the schedule card used for both today's tasks (a "Leftover"
// group of yesterday's open tasks above a "Today" group) and the selected day's events (a plain
// list), and the later-days card grouping the rest of the week's events by day. A task row has a
// rounded-square checkbox (editors tap an open one to complete it; a done or completing one is
// checked and greyed, with a detail line saying who confirmed it) and tappable text that opens
// the task's autosaving inline note editor (no Save or Cancel). A saved note shows as a "Note:"
// subtitle. In task and event rows the time and the label share one text baseline and the
// subtitles line up under the label. Task rows are separated by hairlines that start at the
// text; event rows keep their calendar icon. They take plain data from format.ts and render
// the Figma design: warm translucent cards, serious status colors for alerts, accent-tinted
// selection. No motion.
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { PrimaryButton } from '../components/PrimaryButton';
import type { DayTask } from '../day/types';
import { displayTime } from '../day/format';
import { colors, statusTones } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';
import {
  canEditNote,
  checkboxInteractive,
  checkboxKind,
  claimText,
  noteLine,
  type CheckboxKind,
  type LaterDayGroup,
  weekMonthLabel,
  type ScheduleRowData,
  VARIANT_STYLE,
  type WeekStripDay,
} from './format';
import type { TaskActionState } from './useTaskActions';

const alertTone = statusTones.serious;

/** Fill of a checked checkbox: the secondary text color, softened. */
const DONE_FILL = 'rgba(77,77,77,0.55)';

/** Width (points) of the time column and the gap after it; subtitles indent past both. */
const TIME_WIDTH = 72;
const LABEL_INDENT = TIME_WIDTH + 12;

/** Line height (points) of the label text (type.body), which the event icon is centered on. */
const BODY_LINE_HEIGHT = 24;

/**
 * purpose: The top of a caregiver tab: a title with an optional trailing control, and a subtitle.
 * @param props: ({ title: string, subtitle: string, trailing?: ReactNode }) The texts and the
 *        control shown at the right of the title (for example the account button).
 * @return: (JSX.Element) The header.
 */
export function ScreenHeader({
  title,
  subtitle,
  trailing,
}: {
  title: string;
  subtitle: string;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerTitleRow}>
        <Text accessibilityRole="header" style={[type.title, styles.fill]} numberOfLines={2}>
          {title}
        </Text>
        {trailing}
      </View>
      <Text style={type.subtitle}>{subtitle}</Text>
    </View>
  );
}

/**
 * purpose: A small uppercase heading for a Home section.
 * @param props: ({ text: string }) The heading.
 * @return: (JSX.Element) The heading.
 */
export function SectionTitle({ text }: { text: string }) {
  return (
    <Text accessibilityRole="header" style={type.section}>
      {text}
    </Text>
  );
}

/**
 * purpose: One cell of the week strip, a button that selects the day: weekday, date and a dot
 *          when the day has events. The selected day is filled with the accent color; today, when
 *          not selected, shows its date number in the accent color.
 * @param props: ({ day: WeekStripDay, selected: boolean, onSelect: (localDate: string) => void })
 *        The day, whether it is the selected one and the press handler.
 * @return: (JSX.Element) The cell.
 */
function WeekStripCell({
  day,
  selected,
  onSelect,
}: {
  day: WeekStripDay;
  selected: boolean;
  onSelect: (localDate: string) => void;
}) {
  const { accentColor } = useTheme();
  const dateColor = selected ? colors.onAccent : day.isToday ? accentColor : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={day.accessibilityLabel}
      accessibilityHint="Shows this day's schedule"
      accessibilityState={{ selected }}
      onPress={() => onSelect(day.localDate)}
      style={({ pressed }) => [
        styles.dayCell,
        selected && { backgroundColor: accentColor },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[type.caption, { color: selected ? colors.onAccent : colors.secondaryText }]}>
        {day.weekdayShort}
      </Text>
      <Text style={[type.headline, { color: dateColor }]}>{day.dayOfMonth}</Text>
      <View
        style={[
          styles.dot,
          day.hasMarker && { backgroundColor: selected ? colors.onAccent : accentColor },
        ]}
      />
    </Pressable>
  );
}

/**
 * purpose: The calendar card: the month and year of today, then the seven-day week strip whose
 *          cells select the day the schedule shows.
 * @param props: ({ todayLocalDate: string, days: WeekStripDay[], selectedDate: string,
 *        onSelect: (localDate: string) => void }) Today's date, the cells, the selected local
 *        date and the handler called with a tapped cell's date.
 * @return: (JSX.Element) The card.
 */
export function CalendarCard({
  todayLocalDate,
  days,
  selectedDate,
  onSelect,
}: {
  todayLocalDate: string;
  days: WeekStripDay[];
  selectedDate: string;
  onSelect: (localDate: string) => void;
}) {
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={type.headline}>
        {weekMonthLabel(todayLocalDate)}
      </Text>
      <View style={styles.weekStrip}>
        {days.map((day) => (
          <WeekStripCell
            key={day.localDate}
            day={day}
            selected={day.localDate === selectedDate}
            onSelect={onSelect}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * purpose: One alert: a task that was not confirmed. When someone has claimed it the card says
 *          who is on it ("You're on it" for the signed-in caregiver); otherwise editors get the
 *          "I'm on it" button. Editors also get "Mark done", which asks for a note. Each shows
 *          a spinner while its call runs, and a failed call shows the error in the card and
 *          keeps the buttons. The message (from alertMessage) says when a task is left over
 *          from yesterday.
 * @param props: ({ task: DayTask, message: string, action: TaskActionState | undefined,
 *        canEdit: boolean, userId: string | null, onClaim: () => Promise<void>,
 *        onMarkDone: () => void }) The task, the text under its title, its in-flight or failed
 *        action, whether this caregiver may act (editors only), their Clerk user id, and the
 *        handlers for "I'm on it" and "Mark done".
 * @return: (JSX.Element) The card.
 */
export function AlertCard({
  task,
  message,
  action,
  canEdit,
  userId,
  onClaim,
  onMarkDone,
}: {
  task: DayTask;
  message: string;
  action: TaskActionState | undefined;
  canEdit: boolean;
  userId: string | null;
  onClaim: () => Promise<void>;
  onMarkDone: () => void;
}) {
  const claimed = claimText(task, userId);
  const working = action?.status === 'claiming' || action?.status === 'marking';
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.alertCard,
        { backgroundColor: alertTone.background, borderColor: alertTone.separator },
      ]}
    >
      <View style={styles.alertTitleRow}>
        <SymbolView name="exclamationmark.triangle" size={20} tintColor={alertTone.foreground} />
        <Text style={[type.bodyStrong, styles.fill, styles.alertText]}>
          {`${task.displayLabel} not confirmed`}
        </Text>
        <Text style={[type.caption, styles.alertText]}>{displayTime(task.scheduledTime)}</Text>
      </View>
      <Text style={[type.callout, styles.alertText]}>{message}</Text>
      {action?.status === 'error' && (
        <Text style={[type.callout, styles.alertText]}>{action.message}</Text>
      )}
      <View style={styles.alertActions}>
        {claimed !== null ? (
          <Text style={[type.button, styles.alertText]}>{claimed}</Text>
        ) : (
          canEdit && (
            <PrimaryButton
              compact
              label="I'm on it"
              accessibilityLabel={`I'm on it, ${task.displayLabel}`}
              busy={action?.status === 'claiming'}
              disabled={working}
              onPress={onClaim}
            />
          )
        )}
        {canEdit && (
          <PrimaryButton
            compact
            variant="outline"
            tone={alertTone.foreground}
            label="Mark done"
            accessibilityLabel={`Mark done, ${task.displayLabel}`}
            busy={action?.status === 'marking'}
            disabled={working}
            onPress={onMarkDone}
          />
        )}
      </View>
    </View>
  );
}

/**
 * purpose: One line of the schedule for an event: calendar icon, then time and label on one
 *          text baseline. The icon is centered on that first line. Not pressable.
 * @param props: ({ row: ScheduleRowData }) The row.
 * @return: (JSX.Element) The row.
 */
function ScheduleRow({ row }: { row: ScheduleRowData }) {
  return (
    <View accessible accessibilityLabel={row.accessibilityLabel} style={styles.row}>
      <View style={styles.iconSlot}>
        <SymbolView
          name={VARIANT_STYLE[row.variant].icon}
          size={22}
          tintColor={colors.secondaryText}
        />
      </View>
      <View style={styles.titleLine}>
        <Text style={[type.callout, styles.rowTime, { color: colors.secondaryText }]}>
          {row.time}
        </Text>
        <Text style={[type.body, styles.fill]}>{row.label}</Text>
      </View>
    </View>
  );
}

/**
 * purpose: The rounded-square box of a task row: empty with a grey border when open, a red border
 *          for an unconfirmed task, filled grey with a white check when done.
 * @param props: ({ kind: CheckboxKind }) The look.
 * @return: (JSX.Element) The 22pt box.
 */
function CheckboxBox({ kind }: { kind: CheckboxKind }) {
  return (
    <View
      style={[
        styles.box,
        { borderColor: kind === 'alert' ? alertTone.foreground : colors.secondaryText },
        kind === 'done' && { backgroundColor: DONE_FILL, borderColor: DONE_FILL },
      ]}
    >
      {kind === 'done' && (
        <SymbolView name="checkmark" size={14} weight="semibold" tintColor={colors.surface} />
      )}
    </View>
  );
}

/**
 * purpose: The inline note editor under a task row: a multiline field prefilled with the current
 *          note (or a draft that failed to save). It has no buttons: the note is saved when the
 *          editor closes. The keyboard's Done and the field losing focus close it.
 * @param props: ({ initial: string, onChange: (text: string) => void, onClose: () => void })
 *        The starting text, the handler for every edit and the handler for Done or blur.
 * @return: (JSX.Element) The editor.
 */
function NoteEditor({
  initial,
  onChange,
  onClose,
}: {
  initial: string;
  onChange: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <View style={styles.noteEditor}>
      <TextInput
        multiline
        autoFocus
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          onChange(text);
        }}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={onClose}
        onBlur={onClose}
        placeholder="Add a note for the family"
        placeholderTextColor={colors.secondaryText}
        accessibilityLabel="Note"
        maxLength={500}
        style={[type.body, styles.noteInput]}
      />
    </View>
  );
}

/**
 * purpose: One task row. The first line has the checkbox, then time and label on one text
 *          baseline; the who-confirmed detail, the "Note: ..." subtitle and any pending, saving or
 *          failed action sit under the label. Editors tick an open task's checkbox to mark it done
 *          (shown as checked at once; the screen decides when it is sent) and tap the text to
 *          open the autosaving note editor. Viewers can tap a truncated note to read all of it.
 *          A hairline above the text column separates it from the row before.
 * @param props: ({ row, first, canEdit, action, completing, editing, initialDraft, onMarkDone,
 *        onToggleNote, onDraftChange, onCloseNote }) The task row, whether it is the first in its
 *        list (no divider), whether this caregiver may edit, its in-flight or failed action,
 *        whether it shows as done while its completion is pending, whether its note editor is
 *        open, the editor's starting text, and the handlers for the checkbox, the text tap, every
 *        edit and the editor closing.
 * @return: (JSX.Element) The row.
 */
function TaskRow({
  row,
  first,
  canEdit,
  action,
  completing,
  editing,
  initialDraft,
  onMarkDone,
  onToggleNote,
  onDraftChange,
  onCloseNote,
}: {
  row: ScheduleRowData;
  first: boolean;
  canEdit: boolean;
  action?: TaskActionState;
  completing: boolean;
  editing: boolean;
  initialDraft: string;
  onMarkDone: () => void;
  onToggleNote: () => void;
  onDraftChange: (text: string) => void;
  onCloseNote: () => void;
}) {
  const [noteShown, setNoteShown] = useState(false);
  const marking = action?.status === 'marking';
  const kind = completing || marking ? 'done' : (checkboxKind(row.variant) ?? 'open');
  const done = kind === 'done';
  const alert = kind === 'alert';
  const interactive = checkboxInteractive(row, canEdit) && !completing;
  const editable = canEditNote(row, canEdit);
  const noteText = noteLine(row.note);
  const textActive = editable || noteText !== null;
  return (
    <View style={[styles.taskRow, alert && { backgroundColor: alertTone.background }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`Mark ${row.label} done`}
        accessibilityState={{ checked: done, disabled: !interactive || marking, busy: marking }}
        disabled={!interactive || marking}
        onPress={onMarkDone}
        style={({ pressed }) => [styles.checkboxTarget, interactive && pressed && styles.pressed]}
      >
        <CheckboxBox kind={kind} />
      </Pressable>
      <View style={[styles.taskBody, !first && styles.divider]}>
        <Pressable
          accessible
          accessibilityRole="button"
          accessibilityLabel={row.accessibilityLabel}
          accessibilityHint={
            editable ? (editing ? 'Saves and closes the note' : 'Edits the note') : undefined
          }
          accessibilityState={{ expanded: editable ? editing : noteShown }}
          disabled={!textActive}
          onPress={editable ? onToggleNote : () => setNoteShown((shown) => !shown)}
        >
          <View style={styles.titleLine}>
            <Text
              style={[
                type.callout,
                styles.rowTime,
                { color: alert && !done ? alertTone.foreground : colors.secondaryText },
              ]}
            >
              {row.time}
            </Text>
            <Text
              style={[
                alert && !done ? type.bodyStrong : type.body,
                styles.fill,
                done && { color: colors.secondaryText },
              ]}
            >
              {row.label}
            </Text>
          </View>
          <View style={styles.subtitles}>
            {row.detail !== null && (
              <Text style={[type.caption, { color: colors.secondaryText }]}>{row.detail}</Text>
            )}
            {noteText !== null && !editing && (
              <Text
                numberOfLines={noteShown ? undefined : 2}
                style={[type.caption, { color: colors.secondaryText }]}
              >
                {noteText}
              </Text>
            )}
            {marking && <Text style={[type.caption, styles.rowStatus]}>Marking done...</Text>}
            {action?.status === 'saving' && (
              <Text style={[type.caption, { color: colors.secondaryText }]}>Saving note...</Text>
            )}
            {action?.status === 'error' && (
              <Text style={[type.caption, styles.rowStatus]}>{action.message}</Text>
            )}
          </View>
        </Pressable>
        {editing && (
          <NoteEditor initial={initialDraft} onChange={onDraftChange} onClose={onCloseNote} />
        )}
      </View>
    </View>
  );
}

/**
 * purpose: A schedule card: an optional "Leftover" group (yesterday's open tasks), then the rows.
 *          When the Leftover group is present the rows get a "Today" group header; otherwise they
 *          are a plain list. With nothing to show, one calm line. Task rows have checkboxes and
 *          notes (see TaskRow); event rows are plain. Only one task's note is open at a time.
 * @param props: ({ leftover, rows, emptyText, canEdit, actions, pendingId, openNoteId,
 *        initialDraft, onMarkDone, onToggleNote, onDraftChange, onCloseNote }) The leftover rows
 *        (empty for events), the main rows, the line shown when both are empty, whether this
 *        caregiver may edit, the in-flight or failed actions by instance id, the instance whose
 *        completion is pending (shown as done), the id of the row whose note is open (or null)
 *        with the editor's starting text, and the handlers: mark done (by instance id), toggle a
 *        row's note (by row), every edit of the open note and the open note closing.
 * @return: (JSX.Element) The card.
 */
export function ScheduleCard({
  leftover,
  rows,
  emptyText,
  canEdit,
  actions,
  pendingId,
  openNoteId,
  initialDraft,
  onMarkDone,
  onToggleNote,
  onDraftChange,
  onCloseNote,
}: {
  leftover: ScheduleRowData[];
  rows: ScheduleRowData[];
  emptyText: string;
  canEdit: boolean;
  actions: Partial<Record<string, TaskActionState>>;
  pendingId: string | null;
  openNoteId: string | null;
  initialDraft: string;
  onMarkDone: (instanceId: NonNullable<ScheduleRowData['instanceId']>) => void;
  onToggleNote: (row: ScheduleRowData) => void;
  onDraftChange: (text: string) => void;
  onCloseNote: () => void;
}) {
  /**
   * purpose: Render one row of a list: a task row with checkbox and note, or an event row.
   * @param row: (ScheduleRowData) The row.
   * @param index: (number) Its position in its list (the first has no divider).
   * @return: (JSX.Element) The row.
   */
  const renderRow = (row: ScheduleRowData, index: number) => {
    const { instanceId } = row;
    if (instanceId === null) return <ScheduleRow key={row.id} row={row} />;
    return (
      <TaskRow
        key={row.id}
        row={row}
        first={index === 0}
        canEdit={canEdit}
        action={actions[instanceId]}
        completing={pendingId === instanceId}
        editing={openNoteId === row.id}
        initialDraft={initialDraft}
        onMarkDone={() => onMarkDone(instanceId)}
        onToggleNote={() => onToggleNote(row)}
        onDraftChange={onDraftChange}
        onCloseNote={onCloseNote}
      />
    );
  };
  const hasLeftover = leftover.length > 0;
  return (
    <View style={styles.scheduleCard}>
      {!hasLeftover && rows.length === 0 && (
        <Text style={[type.callout, styles.emptyLine]}>{emptyText}</Text>
      )}
      {hasLeftover && (
        <View style={styles.group}>
          <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
            Leftover
          </Text>
          {leftover.map(renderRow)}
        </View>
      )}
      {hasLeftover && rows.length > 0 && (
        <View style={styles.group}>
          <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
            Today
          </Text>
          {rows.map(renderRow)}
        </View>
      )}
      {!hasLeftover && rows.length > 0 && <View style={styles.rows}>{rows.map(renderRow)}</View>}
    </View>
  );
}

/**
 * purpose: The "Later this week" card: one group per later day with events, each with its
 *          weekday and date as a heading above that day's rows.
 * @param props: ({ groups: LaterDayGroup[] }) The groups from laterThisWeek.
 * @return: (JSX.Element) The card.
 */
export function LaterWeekCard({ groups }: { groups: LaterDayGroup[] }) {
  return (
    <View style={styles.scheduleCard}>
      {groups.map((group) => (
        <View key={group.date} style={styles.group}>
          <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
            {group.title}
          </Text>
          {group.rows.map((row) => (
            <ScheduleRow key={row.id} row={row} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { gap: 4 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  card: { gap: 8, padding: 12, borderRadius: 18, backgroundColor: colors.overlayMedium },
  weekStrip: { flexDirection: 'row', justifyContent: 'space-between' },
  dayCell: {
    width: 44,
    paddingVertical: 8,
    gap: 4,
    borderRadius: 12,
    alignItems: 'center',
  },
  pressed: { opacity: 0.6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  alertCard: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  alertTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alertText: { color: alertTone.foreground },
  alertActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  scheduleCard: {
    gap: 16,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: colors.overlayMedium,
  },
  emptyLine: { color: colors.secondaryText, paddingHorizontal: 20, paddingVertical: 4 },
  rows: { gap: 4, paddingHorizontal: 8 },
  group: { gap: 4, paddingHorizontal: 8 },
  groupTitle: { paddingTop: 4, paddingHorizontal: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  iconSlot: { height: BODY_LINE_HEIGHT, justifyContent: 'center' },
  titleLine: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  subtitles: { marginLeft: LABEL_INDENT },
  rowTime: { width: TIME_WIDTH, fontVariant: ['tabular-nums'] },
  taskRow: { flexDirection: 'row', alignItems: 'flex-start', borderRadius: 12 },
  checkboxTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskBody: { flex: 1, minHeight: 44, paddingVertical: 10, paddingRight: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  noteEditor: { paddingTop: 8 },
  noteInput: {
    minHeight: 72,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.separator,
    backgroundColor: colors.surface,
    textAlignVertical: 'top',
  },
  rowStatus: { color: alertTone.foreground },
});
