// sunny_app/src/caregiver/CaregiverComponents.tsx
//
// Purpose: The building blocks of the caregiver Home tab: the screen header (title, subtitle
// and optional trailing control), the section title, the calendar card with its seven-day week
// strip (tappable cells that select a day), the alert card with its "I'm on it" action (or who
// is already on it), and the schedule card for the selected day. They take plain data from
// format.ts and render the Figma design: warm translucent cards, serious status colors for
// alerts, accent-tinted selection. No motion.
//
// Last modified: 2026-10-31

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
  alertMessage,
  claimText,
  weekMonthLabel,
  type ScheduleRowData,
  VARIANT_STYLE,
  type WeekStripDay,
} from './format';
import type { ClaimState } from './useClaimTasks';

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
 *          when the day has events. The selected day is filled with the accent color; today,
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
      accessibilityState={{ selected }}
      onPress={() => onSelect(day.localDate)}
      style={[styles.dayCell, selected && { backgroundColor: accentColor }]}
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
 *          "I'm on it" button, which shows a spinner while the claim runs. A failed claim shows
 *          the error in the card and keeps the button.
 * @param props: ({ task: DayTask, claim: ClaimState | undefined, canClaim: boolean,
 *        userId: string | null, onClaim: () => Promise<void> }) The task, its in-flight or
 *        failed claim, whether this caregiver may claim (editors only), their Clerk user id and
 *        the press handler.
 * @return: (JSX.Element) The card.
 */
export function AlertCard({
  task,
  claim,
  canClaim,
  userId,
  onClaim,
}: {
  task: DayTask;
  claim: ClaimState | undefined;
  canClaim: boolean;
  userId: string | null;
  onClaim: () => Promise<void>;
}) {
  const claimed = claimText(task, userId);
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
      <Text style={[type.callout, styles.alertText]}>{alertMessage(task)}</Text>
      {claim?.status === 'error' && (
        <Text style={[type.callout, styles.alertText]}>{claim.message}</Text>
      )}
      {claimed !== null ? (
        <Text style={[type.button, styles.alertText]}>{claimed}</Text>
      ) : (
        canClaim && (
          <PrimaryButton
            compact
            label="I'm on it"
            accessibilityLabel={`I'm on it, ${task.displayLabel}`}
            busy={claim?.status === 'claiming'}
            onPress={onClaim}
          />
        )
      )}
    </View>
  );
}

/**
 * purpose: One line of the schedule: icon, time and label. Done tasks are checked off and
 *          struck through; alerts are highlighted in the serious colors.
 * @param props: ({ row: ScheduleRowData }) The row.
 * @return: (JSX.Element) The row.
 */
function ScheduleRow({ row }: { row: ScheduleRowData }) {
  const done = row.variant === 'done';
  const alert = row.variant === 'alert';
  const iconColor = done ? colors.success : alert ? alertTone.foreground : colors.secondaryText;
  return (
    <View
      accessible
      accessibilityLabel={row.accessibilityLabel}
      style={[styles.row, alert && { backgroundColor: alertTone.background }]}
    >
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
      <Text
        style={[
          alert ? type.bodyStrong : type.body,
          styles.fill,
          done && { color: colors.secondaryText, textDecorationLine: 'line-through' },
        ]}
      >
        {row.label}
      </Text>
    </View>
  );
}

/**
 * purpose: The schedule card for the selected day: its rows, or a calm line when nothing is
 *          scheduled. The day's title is the section title above the card.
 * @param props: ({ rows: ScheduleRowData[] }) The rows from scheduleForDate.
 * @return: (JSX.Element) The card.
 */
export function ScheduleCard({ rows }: { rows: ScheduleRowData[] }) {
  return (
    <View style={styles.scheduleCard}>
      {rows.length === 0 && (
        <Text style={[type.callout, styles.emptyLine]}>Nothing scheduled.</Text>
      )}
      <View style={styles.rows}>
        {rows.map((row) => (
          <ScheduleRow key={row.id} row={row} />
        ))}
      </View>
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
  dot: { width: 6, height: 6, borderRadius: 3 },
  alertCard: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  alertTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alertText: { color: alertTone.foreground },
  scheduleCard: {
    gap: 16,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: colors.overlayMedium,
  },
  emptyLine: { color: colors.secondaryText, paddingHorizontal: 20, paddingVertical: 4 },
  rows: { gap: 4, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  rowTime: { width: 72, fontVariant: ['tabular-nums'] },
});
