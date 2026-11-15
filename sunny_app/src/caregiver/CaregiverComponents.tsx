import { SymbolView } from 'expo-symbols';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

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

const DISABLED_OPACITY = 0.4;

const DONE_FILL = 'rgba(77,77,77,0.55)';

const TIME_WIDTH = 72;
const LABEL_INDENT = TIME_WIDTH + 12;

const BODY_LINE_HEIGHT = 24;

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

export function SectionTitle({ text }: { text: string }) {
  return (
    <Text accessibilityRole="header" style={type.section}>
      {text}
    </Text>
  );
}

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

type TitleTone = 'plain' | 'alert' | 'done';

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

export const REOPEN_MESSAGE =
  'It goes back on the list as not done. Reminders and family alerts that are already overdue will go out right away.';

export function confirmReopen(label: string, onReopen: () => void, onClose: () => void): void {
  Alert.alert(
    `Reopen ${label}?`,
    REOPEN_MESSAGE,
    [
      { text: 'Cancel', style: 'cancel', onPress: onClose },
      {
        text: 'Reopen',
        style: 'default',
        onPress: () => {
          onClose();
          onReopen();
        },
      },
    ],
    { onDismiss: onClose },
  );
}

export const TaskRow = memo(function TaskRow({
  row,
  first,
  canEdit,
  action,
  onMarkDone,
  onReopen,
  noteEditor,
}: {
  row: TaskRowData;
  first: boolean;
  canEdit: boolean;
  action?: TaskActionState;
  onMarkDone: (instanceId: TaskInstanceId) => void;
  onReopen: (instanceId: TaskInstanceId) => void;
  noteEditor: NoteEditor;
}) {
  const [noteShown, setNoteShown] = useState(false);
  const asking = useRef(false);
  const marking = action?.status === 'marking';
  const reopening = action?.status === 'reopening';
  const busy = marking || reopening;
  const { kind, interactive } = checkboxState(row, { canEdit, busy });
  const done = kind === 'done';
  const reopens = reopening || (done && interactive);

  const askReopen = (): void => {
    if (asking.current) return;
    asking.current = true;
    confirmReopen(
      row.label,
      () => onReopen(row.instanceId),
      () => {
        asking.current = false;
      },
    );
  };
  const alert = row.variant === 'alert' && !done;
  const editing = noteEditor.open?.rowId === row.id;
  const noteText = noteLine(row.note);
  const textActive = canEdit || noteText !== null;
  return (
    <View style={[styles.taskRow, alert && { backgroundColor: alertTone.background }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={reopens ? `Reopen ${row.label}` : `Mark ${row.label} done`}
        accessibilityState={{ checked: done, disabled: !interactive, busy }}
        disabled={!interactive}
        onPress={reopens ? askReopen : () => onMarkDone(row.instanceId)}
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
            {reopening && (
              <Text style={[type.caption, { color: colors.secondaryText }]}>Reopening...</Text>
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

export interface TaskRowActions {
  states: Partial<Record<string, TaskActionState>>;
  markDone: (instanceId: TaskInstanceId) => void;
  reopen: (instanceId: TaskInstanceId) => void;
}

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
  const renderRow = (row: TaskRowData, index: number) => (
    <TaskRow
      key={row.id}
      row={row}
      first={index === 0}
      canEdit={canEdit}
      action={rowActions.states[row.instanceId]}
      onMarkDone={rowActions.markDone}
      onReopen={rowActions.reopen}
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

export const PlannedTasksCard = memo(function PlannedTasksCard({
  rows,
  emptyText,
  dayTitle,
}: {
  rows: PlannedTaskRowData[];
  emptyText: string;
  dayTitle: string;
}) {
  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={`Tasks for ${dayTitle}`}
      style={styles.scheduleCard}
    >
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

function EventRows({ rows }: { rows: EventRowData[] }) {
  return (
    <>
      {rows.map((row) => (
        <ScheduleRow key={row.id} row={row} />
      ))}
    </>
  );
}

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
