// sunny_app/src/caregiver/CaregiverHomeScreen.tsx
//
// Purpose: The caregiver Home tab: "<name>'s week" with the account button, the calendar card
// (seven-day week strip whose cells choose the day shown), the Alerts section (tasks that were
// escalated or missed, with an "I'm on it" button for editors, or who is already on it) and the
// schedule of the selected day (today by default) followed by "Later this week", the events of
// the days after it grouped by day (hidden when there are none). Everything comes from the
// shared day view state owned by CaregiverApp, and the derived lists are computed once per day
// view and selection. While the first load is pending it shows a spinner, and if it fails with
// nothing cached, the error message.
//
// Last modified: 2026-10-31

import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  buildWeekStrip,
  isAlert,
  laterThisWeek,
  resolveSelectedDate,
  scheduleForDate,
  selectedDayTitle,
  weekRangeLabel,
  type DaySelection,
} from './format';
import { useTabBarInset } from './tabBarInset';
import { useClaimTasks } from './useClaimTasks';

/** Props for CaregiverHomeScreen. */
interface CaregiverHomeScreenProps {
  dayView: DayViewState;
  /** Whether this caregiver may claim alerts (everyone but viewers). */
  canClaim: boolean;
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
 * @param props: (CaregiverHomeScreenProps) The shared day view, the claim permission, the
 *        caregiver's user id and the account button handler.
 * @return: (JSX.Element) The screen.
 */
export function CaregiverHomeScreen({
  dayView,
  canClaim,
  userId,
  onAccountPress,
}: CaregiverHomeScreenProps) {
  const { day, agenda, errorMessage, isOffline } = dayView;
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { claims, claim } = useClaimTasks();
  const [selection, setSelection] = useState<DaySelection | null>(null);
  const view = useMemo(() => {
    if (day === null) return null;
    const strip = buildWeekStrip(day);
    const selectedDate = resolveSelectedDate(strip, day.localDate, selection);
    return {
      alerts: day.tasks.filter(isAlert),
      strip,
      selectedDate,
      scheduleTitle: selectedDayTitle(day.localDate, selectedDate),
      schedule: scheduleForDate(day, agenda, selectedDate),
      later: laterThisWeek(day, strip, selectedDate),
      range: weekRangeLabel(day.localDate),
    };
  }, [day, agenda, selection]);

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
            {view.alerts.map((task) => (
              <AlertCard
                key={task.instanceId}
                task={task}
                claim={claims[task.instanceId]}
                canClaim={canClaim}
                userId={userId}
                onClaim={() => claim(task.instanceId)}
              />
            ))}
          </View>
          <View style={styles.section}>
            <SectionTitle text={view.scheduleTitle} />
            <ScheduleCard rows={view.schedule} />
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
