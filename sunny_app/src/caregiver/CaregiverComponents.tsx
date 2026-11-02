// sunny_app/src/caregiver/CaregiverComponents.tsx
//
// Purpose: The building blocks of the caregiver Home tab: the screen header (title, subtitle
// and optional trailing control), the section title, the calendar card with its seven-day week
// strip (tappable cells that select a day), the alert card with its "I'm on it" and "Mark done"
// actions (or who is already on it), the tasks card (a "Leftover" group of yesterday's open
// tasks above a "Today" group), the planned tasks card (a future selected day's tasks, read-only
// rows with a dulled disabled checkbox, in their own card above that day's events), the events card (the selected day's events as a plain list) and
// the later-days card grouping the rest of the week's events by day. A task row has a
// rounded-square checkbox (editors tap an open one to mark it done; a done or marking one is
// checked and greyed, with a detail line saying who confirmed it; an open one a viewer cannot
// tick is dulled) and tappable text that opens the task's autosaving inline note editor (no Save
// or Cancel). A saved note shows as a "Note:" subtitle. In task and event rows the time and the
// label share one text baseline (TitleLine) and the subtitles line up under the label. Task rows
// are separated by hairlines that start at the text; event rows keep their calendar icon. The
// cards that sit on a screen that re-renders often (calendar, alert, task row, events, later
// days) are memoized, so the screen passes them stable callbacks. They take plain data from
// format.ts and render the Figma design: warm translucent cards, serious status colors for
// alerts, accent-tinted selection. No motion.
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { TaskInstanceId } from '../backend/convexApi';
import { PrimaryButton } from '../components/PrimaryButton';
import type { DayTask } from '../day/types';
import { displayTime } from '../day/format';
import { colors, statusTones } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';
import {
  checkboxState,
  claimText,
  noteLine,
  type CheckboxKind,
  type EventRowData,
  type LaterDayGroup,
  type PlannedTaskRowData,
  weekMonthLabel,
  type TaskRowData,
  type WeekStripDay,
} from './format';
import { useReportNoteFocus } from './tabBarInset';
import type { NoteEditor } from './useNoteEditor';
import type { TaskActionState } from './useTaskActions';

const alertTone = statusTones.serious;

/** Opacity of the box of an open task that cannot be ticked. */
const DISABLED_OPACITY = 0.4;

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
 *          cells select the day the schedule shows. Memoized.
 * @param props: ({ todayLocalDate: string, days: WeekStripDay[], selectedDate: string,
 *        onSelect: (localDate: string) => void }) Today's date, the cells, the selected local
 *        date and the handler called with a tapped cell's date.
 * @return: (JSX.Element) The card.
 */
export const CalendarCard = memo(function CalendarCard({
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
});

/**
 * purpose: One alert: a task that was not confirmed. When someone has claimed it the card says
 *          who is on it ("You're on it" for the signed-in caregiver); otherwise editors get the
 *          "I'm on it" button. Editors also get "Mark done", which marks the task done at
 *          once (no note is asked for). Each shows a spinner while its call runs, and a failed
 *          call shows the error in the card and keeps the buttons. The message (from
 *          alertMessage) says when a task is left over from yesterday. Memoized.
 * @param props: ({ task: DayTask, message: string, action: TaskActionState | undefined,
 *        canEdit: boolean, userId: string | null, onClaim: (id: TaskInstanceId) => Promise<void>,
 *        onMarkDone: (id: TaskInstanceId) => void }) The task, the text under its title, its
 *        in-flight or failed action, whether this caregiver may act (editors only), their Clerk
 *        user id, and the handlers for "I'm on it" and "Mark done" (called with the task's
 *        instance id).
 * @return: (JSX.Element) The card.
 */
export const AlertCard = memo(function AlertCard({
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
  onClaim: (instanceId: TaskInstanceId) => Promise<void>;
  onMarkDone: (instanceId: TaskInstanceId) => void;
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
              onPress={() => onClaim(task.instanceId)}
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
            onPress={() => onMarkDone(task.instanceId)}
          />
        )}
      </View>
    </View>
  );
});

/** How a title line is drawn: plain, an unconfirmed alert (serious time, strong label) or done (greyed). */
type TitleTone = 'plain' | 'alert' | 'done';

/**
 * purpose: The first line of a task or event row: the time and the label on one text baseline.
 * @param props: ({ time: string, label: string, tone: TitleTone }) The time text, the label
 *        text and how to draw them.
 * @return: (JSX.Element) The line.
 */
function TitleLine({ time, label, tone }: { time: string; label: string; tone: TitleTone }) {
  return (
    <View style={styles.titleLine}>
      <Text
        style={[
          type.callout,
          styles.rowTime,
          { color: tone === 'alert' ? alertTone.foreground : colors.secondaryText },
        ]}
      >
        {time}
      </Text>
      <Text
        style={[
          tone === 'alert' ? type.bodyStrong : type.body,
          styles.fill,
          tone === 'done' && { color: colors.secondaryText },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * purpose: One line of the schedule for an event: calendar icon, then time and label on one
 *          text baseline. The icon is centered on that first line. Not pressable.
 * @param props: ({ row: EventRowData }) The row.
 * @return: (JSX.Element) The row.
 */
function ScheduleRow({ row }: { row: EventRowData }) {
  return (
    <View accessible accessibilityLabel={row.accessibilityLabel} style={styles.row}>
      <View style={styles.iconSlot}>
        <SymbolView name="calendar" size={22} tintColor={colors.secondaryText} />
      </View>
      <TitleLine time={row.time} label={row.label} tone="plain" />
    </View>
  );
}

/**
 * purpose: The rounded-square box of a task row: empty with a grey border when open, a red border
 *          for an unconfirmed task, filled grey with a white check when done, and a light border
 *          at reduced opacity when it is open but cannot be ticked (disabled).
 * @param props: ({ kind: CheckboxKind }) The look.
 * @return: (JSX.Element) The 22pt box.
 */
function CheckboxBox({ kind }: { kind: CheckboxKind }) {
  return (
    <View
      style={[
        styles.box,
        { borderColor: kind === 'alert' ? alertTone.foreground : colors.secondaryText },
        kind === 'disabled' && { borderColor: colors.separator, opacity: DISABLED_OPACITY },
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
 * purpose: The inline note editor under a task row: an uncontrolled multiline field that starts
 *          with the current note (or a draft that failed to save). It has no buttons: every
 *          edit is reported to the note editor hook, which saves when the editor closes. The
 *          field losing focus closes it (the keyboard's Done and dragging the screen both blur
 *          it), reporting its row id so a late blur cannot close another row's editor. It also
 *          reports focus and blur to the tab bar (hidden while a note has focus, since a
 *          hardware keyboard fires no keyboard events), and blur when it unmounts.
 * @param props: ({ rowId: string, initial: string, onChange: (text: string) => void,
 *        onClose: (rowId: string) => void }) The row, the starting text, the handler for every
 *        edit and the handler for losing focus.
 * @return: (JSX.Element) The editor.
 */
function NoteEditorField({
  rowId,
  initial,
  onChange,
  onClose,
}: {
  rowId: string;
  initial: string;
  onChange: (text: string) => void;
  onClose: (rowId: string) => void;
}) {
  const reportFocus = useReportNoteFocus();
  useEffect(() => () => reportFocus(false), [reportFocus]);
  return (
    <View style={styles.noteEditor}>
      <TextInput
        multiline
        autoFocus
        defaultValue={initial}
        onChangeText={onChange}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onFocus={() => reportFocus(true)}
        onBlur={() => {
          reportFocus(false);
          onClose(rowId);
        }}
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
 *          baseline; the who-confirmed detail, the "Note: ..." subtitle and any running or
 *          failed action sit under the label. Editors tick an open task's checkbox to mark it
 *          done (it shows checked while the call runs and stays checked once the day view says
 *          done) and tap the text to open the autosaving note editor. Viewers can tap a
 *          truncated note to read all of it. A hairline above the text column separates it from
 *          the row before. Memoized: it re-renders only when its own props change.
 * @param props: ({ row, first, canEdit, action, onMarkDone, noteEditor }) The task row, whether
 *        it is the first in its list (no divider), whether this caregiver may edit, its running
 *        or failed action, the checkbox handler (called with the task instance) and the note
 *        editor shared by all rows.
 * @return: (JSX.Element) The row.
 */
export const TaskRow = memo(function TaskRow({
  row,
  first,
  canEdit,
  action,
  onMarkDone,
  noteEditor,
}: {
  row: TaskRowData;
  first: boolean;
  canEdit: boolean;
  action?: TaskActionState;
  onMarkDone: (instanceId: TaskInstanceId) => void;
  noteEditor: NoteEditor;
}) {
  const [noteShown, setNoteShown] = useState(false);
  const marking = action?.status === 'marking';
  const { kind, interactive } = checkboxState(row, { canEdit, busy: marking });
  const done = kind === 'done';
  const alert = row.variant === 'alert' && !done;
  const editing = noteEditor.open?.rowId === row.id;
  const noteText = noteLine(row.note);
  const textActive = canEdit || noteText !== null;
  return (
    <View style={[styles.taskRow, alert && { backgroundColor: alertTone.background }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`Mark ${row.label} done`}
        accessibilityState={{ checked: done, disabled: !interactive, busy: marking }}
        disabled={!interactive}
        onPress={() => onMarkDone(row.instanceId)}
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
            canEdit ? (editing ? 'Saves and closes the note' : 'Edits the note') : undefined
          }
          accessibilityState={{ expanded: canEdit ? editing : noteShown }}
          disabled={!textActive}
          onPress={
            canEdit
              ? () =>
                  noteEditor.toggle({
                    rowId: row.id,
                    instanceId: row.instanceId,
                    note: row.note,
                  })
              : () => setNoteShown((shown) => !shown)
          }
        >
          <TitleLine
            time={row.time}
            label={row.label}
            tone={done ? 'done' : alert ? 'alert' : 'plain'}
          />
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
            {action?.status === 'undoing' && (
              <Text style={[type.caption, { color: colors.secondaryText }]}>Undoing...</Text>
            )}
            {action?.status === 'saving' && (
              <Text style={[type.caption, { color: colors.secondaryText }]}>Saving note...</Text>
            )}
            {action?.status === 'error' && (
              <Text style={[type.caption, styles.rowStatus]}>{action.message}</Text>
            )}
          </View>
        </Pressable>
        {editing && noteEditor.open !== null && (
          <NoteEditorField
            rowId={row.id}
            initial={noteEditor.open.initialDraft}
            onChange={noteEditor.setDraft}
            onClose={noteEditor.close}
          />
        )}
      </View>
    </View>
  );
});

/** What the task rows need to act: their running or failed actions, and the checkbox handler. */
export interface TaskRowActions {
  /** Running or failed actions by task instance id. */
  states: Partial<Record<string, TaskActionState>>;
  /** Mark the task done (the checkbox). */
  markDone: (instanceId: TaskInstanceId) => void;
}

/**
 * purpose: The tasks card: an optional "Leftover" group (yesterday's open tasks), then today's
 *          tasks. When the Leftover group is present today's tasks get a "Today" group header;
 *          otherwise they are a plain list. With nothing to show, one calm line. Only one
 *          task's note is open at a time.
 * @param props: ({ leftover, today, canEdit, rowActions, noteEditor }) The leftover rows (may
 *        be empty), today's rows, whether this caregiver may edit, the rows' actions and the
 *        shared note editor.
 * @return: (JSX.Element) The card.
 */
export function TasksCard({
  leftover,
  today,
  canEdit,
  rowActions,
  noteEditor,
}: {
  leftover: TaskRowData[];
  today: TaskRowData[];
  canEdit: boolean;
  rowActions: TaskRowActions;
  noteEditor: NoteEditor;
}) {
  /**
   * purpose: Render one task row of a list.
   * @param row: (TaskRowData) The row.
   * @param index: (number) Its position in its list (the first has no divider).
   * @return: (JSX.Element) The row.
   */
  const renderRow = (row: TaskRowData, index: number) => (
    <TaskRow
      key={row.id}
      row={row}
      first={index === 0}
      canEdit={canEdit}
      action={rowActions.states[row.instanceId]}
      onMarkDone={rowActions.markDone}
      noteEditor={noteEditor}
    />
  );
  const hasLeftover = leftover.length > 0;
  return (
    <View style={styles.scheduleCard}>
      {!hasLeftover && today.length === 0 && (
        <Text style={[type.callout, styles.emptyLine]}>No tasks today.</Text>
      )}
      {hasLeftover && (
        <View style={styles.group}>
          <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
            Leftover
          </Text>
          {leftover.map(renderRow)}
        </View>
      )}
      {hasLeftover && today.length > 0 && (
        <View style={styles.group}>
          <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
            Today
          </Text>
          {today.map(renderRow)}
        </View>
      )}
      {!hasLeftover && today.length > 0 && <View style={styles.rows}>{today.map(renderRow)}</View>}
    </View>
  );
}

/**
 * purpose: One planned task of a future day: the same row look as a task row (time column,
 *          label) with a dulled disabled checkbox. Read-only: the box is not pressable, it has
 *          no note and no actions, and the row's screen reader label says it is planned.
 * @param props: ({ row: PlannedTaskRowData, first: boolean }) The row and whether it is the
 *        first in its list (no divider).
 * @return: (JSX.Element) The row.
 */
function PlannedTaskRow({ row, first }: { row: PlannedTaskRowData; first: boolean }) {
  return (
    <View accessible accessibilityLabel={row.accessibilityLabel} style={styles.taskRow}>
      <View style={styles.checkboxTarget}>
        <CheckboxBox kind="disabled" />
      </View>
      <View style={[styles.taskBody, !first && styles.divider]}>
        <TitleLine time={row.time} label={row.label} tone="plain" />
      </View>
    </View>
  );
}

/**
 * purpose: A card listing the tasks planned on the selected future day, read-only, or one calm
 *          line when there are none. Memoized.
 * @param props: ({ rows: PlannedTaskRowData[], emptyText: string }) The rows and the line shown
 *        when there are none.
 * @return: (JSX.Element) The card.
 */
export const PlannedTasksCard = memo(function PlannedTasksCard({
  rows,
  emptyText,
}: {
  rows: PlannedTaskRowData[];
  emptyText: string;
}) {
  return (
    <View style={styles.scheduleCard}>
      {rows.length === 0 ? (
        <Text style={[type.callout, styles.emptyLine]}>{emptyText}</Text>
      ) : (
        <View style={styles.rows}>
          {rows.map((row, index) => (
            <PlannedTaskRow key={row.id} row={row} first={index === 0} />
          ))}
        </View>
      )}
    </View>
  );
});

/**
 * purpose: The plain list of event rows shared by the events card and the later-days card.
 * @param props: ({ rows: EventRowData[] }) The rows.
 * @return: (JSX.Element) The rows.
 */
function EventRows({ rows }: { rows: EventRowData[] }) {
  return (
    <>
      {rows.map((row) => (
        <ScheduleRow key={row.id} row={row} />
      ))}
    </>
  );
}

/**
 * purpose: A card listing the selected day's events as a plain list, or one calm line when
 *          there are none. Memoized.
 * @param props: ({ rows: EventRowData[], emptyText: string }) The rows and the line shown when
 *        there are none.
 * @return: (JSX.Element) The card.
 */
export const EventsCard = memo(function EventsCard({
  rows,
  emptyText,
}: {
  rows: EventRowData[];
  emptyText: string;
}) {
  return (
    <View style={styles.scheduleCard}>
      {rows.length === 0 ? (
        <Text style={[type.callout, styles.emptyLine]}>{emptyText}</Text>
      ) : (
        <View style={styles.rows}>
          <EventRows rows={rows} />
        </View>
      )}
    </View>
  );
});

/**
 * purpose: The "Later this week" card: one group per later day with events, each with its
 *          weekday and date as a heading above that day's rows. Memoized.
 * @param props: ({ groups: LaterDayGroup[] }) The groups from laterThisWeek.
 * @return: (JSX.Element) The card.
 */
export const LaterWeekCard = memo(function LaterWeekCard({ groups }: { groups: LaterDayGroup[] }) {
  return (
    <View style={styles.scheduleCard}>
      {groups.map((group) => (
        <View key={group.date} style={styles.group}>
          <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
            {group.title}
          </Text>
          <EventRows rows={group.rows} />
        </View>
      ))}
    </View>
  );
});

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
