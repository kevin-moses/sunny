// sunny_app/src/caregiver/CaregiverHomeScreen.tsx
//
// Purpose: The caregiver Home tab: "<name>'s week" with the account button, the calendar card
// (seven-day week strip whose cells choose the day shown), the Alerts section (tasks that were
// escalated or missed, with "I'm on it" and "Mark done" buttons for editors, or who is already on
// it) and the schedule of the selected day (today by default, with a "Leftover" group of
// yesterday's open tasks above it, and open tasks that editors can tap to mark done; "Mark done"
// asks for an optional note) followed by "Later this week", the events of
// the days after it grouped by day (hidden when there are none). Everything comes from the
// shared day view state owned by CaregiverApp, and the derived lists are computed once per day
// view and selection. While the first load is pending it shows a spinner, and if it fails with
// nothing cached, the error message.
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineMark } from '../components/DayComponents';
import type { DayViewState } from '../day/useDayView';
import { colors } from '../theme/colors';
import { type } from '../theme/typography';
import {
  AlertCard,
  CalendarCard,
  LaterWeekCard,
  ScheduleCard,
  ScreenHeader,
  SectionTitle,
} from './CaregiverComponents';
import {
  alertMessage,
  buildWeekStrip,
  isAlert,
  laterThisWeek,
  noteFromPrompt,
  resolveSelectedDate,
  scheduleForDate,
  selectedDayTitle,
  weekRangeLabel,
  type DaySelection,
  type Markable,
} from './format';
import { useTabBarInset } from './tabBarInset';
import { useTaskActions } from './useTaskActions';

/** Props for CaregiverHomeScreen. */
interface CaregiverHomeScreenProps {
  dayView: DayViewState;
  /** Whether this caregiver may claim alerts and mark tasks done (everyone but viewers). */
  canEdit: boolean;
  /** The signed-in caregiver's Clerk user id, to tell their own claims from others'. */
  userId: string | null;
  /** Called when the account button is pressed. */
  onAccountPress: () => void;
}

/**
 * purpose: The round account button at the right of the Home header.
 * @param props: ({ onPress: () => void }) The press handler.
 * @return: (JSX.Element) The button.
 */
function AccountButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Account"
      hitSlop={8}
      onPress={onPress}
    >
      <SymbolView name="person.crop.circle" size={32} tintColor={colors.text} />
    </Pressable>
  );
}

/**
 * purpose: Render the Home tab.
 * @param props: (CaregiverHomeScreenProps) The shared day view, the edit permission, the
 *        caregiver's user id and the account button handler.
 * @return: (JSX.Element) The screen.
 */
export function CaregiverHomeScreen({
  dayView,
  canEdit,
  userId,
  onAccountPress,
}: CaregiverHomeScreenProps) {
  const { day, agenda, errorMessage, isOffline } = dayView;
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { actions, claim, markDone } = useTaskActions();

  /**
   * purpose: Ask the caregiver to confirm marking a task done, with an optional note for the
   *          family, then mark it done. Cancel does nothing.
   * @param markable: ({ instanceId, label }) The task to mark done.
   * @return: (void)
   */
  const askMarkDone = ({ instanceId, label }: Markable): void => {
    Alert.prompt(
      `Mark ${label} done?`,
      'Add a note for the family (optional)',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark done',
          onPress: (text?: string) => void markDone(instanceId, noteFromPrompt(text)),
        },
      ],
      'plain-text',
    );
  };
  const [selection, setSelection] = useState<DaySelection | null>(null);
  const view = useMemo(() => {
    if (day === null) return null;
    const strip = buildWeekStrip(day);
    const selectedDate = resolveSelectedDate(strip, day.localDate, selection);
    const { leftover, rows } = scheduleForDate(day, agenda, selectedDate, userId);
    return {
      alerts: day.tasks.filter(isAlert).map((task) => ({ task, message: alertMessage(task) })),
      strip,
      selectedDate,
      scheduleTitle: selectedDayTitle(day.localDate, selectedDate),
      leftover,
      schedule: rows,
      later: laterThisWeek(day, strip, selectedDate),
      range: weekRangeLabel(day.localDate),
    };
  }, [day, agenda, selection, userId]);

  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 8, paddingBottom: tabBarInset },
      ]}
    >
      <ScreenHeader
        title={day === null ? 'This week' : `${day.seniorPreferredName}'s week`}
        subtitle={view?.range ?? ''}
        trailing={<AccountButton onPress={onAccountPress} />}
      />
      {day === null || view === null ? (
        errorMessage !== null ? (
          <Text style={[type.callout, styles.message]}>{errorMessage}</Text>
        ) : (
          <ActivityIndicator size="large" color={colors.secondaryText} />
        )
      ) : (
        <>
          <CalendarCard
            todayLocalDate={day.localDate}
            days={view.strip}
            selectedDate={view.selectedDate}
            onSelect={(date) => setSelection({ date, todayWhenChosen: day.localDate })}
          />
          <View style={styles.section}>
            <SectionTitle text="Alerts" />
            {view.alerts.length === 0 && (
              <Text style={[type.callout, styles.message]}>Nothing needs attention.</Text>
            )}
            {view.alerts.map(({ task, message }) => (
              <AlertCard
                key={task.instanceId}
                task={task}
                message={message}
                action={actions[task.instanceId]}
                canEdit={canEdit}
                userId={userId}
                onClaim={() => claim(task.instanceId)}
                onMarkDone={() =>
                  askMarkDone({ instanceId: task.instanceId, label: task.displayLabel })
                }
              />
            ))}
          </View>
          <View style={styles.section}>
            <SectionTitle text={view.scheduleTitle} />
            <ScheduleCard
              leftover={view.leftover}
              rows={view.schedule}
              canEdit={canEdit}
              actions={actions}
              onMarkDone={askMarkDone}
            />
          </View>
          {view.later.length > 0 && (
            <View style={styles.section}>
              <SectionTitle text="Later this week" />
              <LaterWeekCard groups={view.later} />
            </View>
          )}
          {isOffline && <OfflineMark />}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, gap: 32 },
  section: { gap: 12 },
  message: { color: colors.secondaryText },
});
