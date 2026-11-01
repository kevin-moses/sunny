// sunny_app/src/caregiver/CaregiverComponents.tsx
//
// Purpose: The building blocks of the caregiver Home tab: the screen header (title, subtitle
// and optional trailing control), the section title, the calendar card with its seven-day week
// strip (tappable cells that select a day), the alert card with its "I'm on it" and "Mark done"
// actions (or who is already on it), the schedule card for the selected day (a "Leftover" group
// of yesterday's open tasks above today's rows, a detail line under done tasks saying who
// confirmed them, and open tasks that editors can tap to mark done), and the later-days card
// grouping the rest of the week's events by day. They take plain data from format.ts and render
// the Figma design: warm translucent cards, serious status colors for alerts, accent-tinted
// selection. No motion.
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '../components/PrimaryButton';
import type { DayTask } from '../day/types';
import { displayTime } from '../day/format';
import { colors, statusTones } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';
import {
  claimText,
  type LaterDayGroup,
  type Markable,
  weekMonthLabel,
  type ScheduleRowData,
  VARIANT_STYLE,
  type WeekStripDay,
} from './format';
import type { TaskActionState } from './useTaskActions';

const alertTone = statusTones.serious;

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
 *          when the day has plans (events, or tasks for today). The selected day is filled with the accent color; today,
 *          when not selected, shows its date number in the accent color.
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
 * purpose: One line of the schedule: icon, time and label. Done tasks are checked off and
 *          struck through with a detail line under them (who confirmed and the note); alerts
 *          are highlighted in the serious colors. A markable row is a button that starts "Mark
 *          done" (disabled while its action runs); any other row is not pressable. A pending or
 *          failed action shows under the label.
 * @param props: ({ row: ScheduleRowData, action?: TaskActionState, markable?: boolean,
 *        onMarkDone?: () => void }) The row, its in-flight or failed action, whether it is
 *        pressable (an editor on an open task) and the press handler.
 * @return: (JSX.Element) The row.
 */
function ScheduleRow({
  row,
  action,
  markable = false,
  onMarkDone,
}: {
  row: ScheduleRowData;
  action?: TaskActionState;
  markable?: boolean;
  onMarkDone?: () => void;
}) {
  const done = row.variant === 'done';
  const alert = row.variant === 'alert';
  const iconColor = done ? colors.success : alert ? alertTone.foreground : colors.secondaryText;
  const marking = action?.status === 'marking';
  const content = (
    <>
      <SymbolView name={VARIANT_STYLE[row.variant].icon} size={22} tintColor={iconColor} />
      <Text
        style={[
          type.callout,
          styles.rowTime,
          { color: alert ? alertTone.foreground : colors.secondaryText },
        ]}
      >
        {row.time}
      </Text>
      <View style={styles.fill}>
        <Text
          style={[
            alert ? type.bodyStrong : type.body,
            done && { color: colors.secondaryText, textDecorationLine: 'line-through' },
          ]}
        >
          {row.label}
        </Text>
        {row.detail !== null && (
          <Text style={[type.caption, { color: colors.secondaryText }]}>{row.detail}</Text>
        )}
        {marking && <Text style={[type.caption, styles.rowStatus]}>Marking done...</Text>}
        {action?.status === 'error' && (
          <Text style={[type.caption, styles.rowStatus]}>{action.message}</Text>
        )}
      </View>
    </>
  );
  return (
    <Pressable
      accessible
      accessibilityRole={markable ? 'button' : undefined}
      accessibilityLabel={row.accessibilityLabel}
      accessibilityHint={markable ? 'Marks this task done' : undefined}
      accessibilityState={markable ? { disabled: marking, busy: marking } : undefined}
      disabled={!markable || marking}
      onPress={onMarkDone}
      style={({ pressed }) => [
        styles.row,
        alert && { backgroundColor: alertTone.background },
        markable && pressed && styles.pressed,
      ]}
    >
      {content}
    </Pressable>
  );
}

/**
 * purpose: The schedule card for the selected day: a "Leftover" group (yesterday's open tasks)
 *          above the day's rows, or a calm line when nothing is scheduled. Editors can tap an
 *          open task to mark it done. The day's title is the section title above the card.
 * @param props: ({ leftover: ScheduleRowData[], rows: ScheduleRowData[], canEdit: boolean,
 *        actions: Partial<Record<string, TaskActionState>>, onMarkDone: (markable: Markable) => void })
 *        The leftover rows and the day's rows from format.ts, whether this caregiver may mark
 *        tasks done, the in-flight or failed actions by instance id, and the "Mark done" handler.
 * @return: (JSX.Element) The card.
 */
export function ScheduleCard({
  leftover,
  rows,
  canEdit,
  actions,
  onMarkDone,
}: {
  leftover: ScheduleRowData[];
  rows: ScheduleRowData[];
  canEdit: boolean;
  actions: Partial<Record<string, TaskActionState>>;
  onMarkDone: (markable: Markable) => void;
}) {
  /**
   * purpose: Render one row, tappable when the caregiver may mark its task done.
   * @param row: (ScheduleRowData) The row.
   * @return: (JSX.Element) The row.
   */
  const renderRow = (row: ScheduleRowData) => {
    const { markable } = row;
    const pressable = canEdit && markable !== null;
    return (
      <ScheduleRow
        key={row.id}
        row={row}
        action={markable === null ? undefined : actions[markable.instanceId]}
        markable={pressable}
        onMarkDone={pressable ? () => onMarkDone(markable) : undefined}
      />
    );
  };
  return (
    <View style={styles.scheduleCard}>
      {leftover.length === 0 && rows.length === 0 && (
        <Text style={[type.callout, styles.emptyLine]}>Nothing scheduled.</Text>
      )}
      {leftover.length > 0 && (
        <View style={styles.group}>
          <Text accessibilityRole="header" style={[type.headline, styles.groupTitle]}>
            Leftover
          </Text>
          {leftover.map(renderRow)}
        </View>
      )}
      <View style={styles.rows}>{rows.map(renderRow)}</View>
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
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  rowTime: { width: 72, fontVariant: ['tabular-nums'] },
  rowStatus: { color: alertTone.foreground },
});
