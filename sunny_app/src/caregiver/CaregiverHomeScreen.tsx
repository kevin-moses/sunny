// sunny_app/src/caregiver/CaregiverHomeScreen.tsx
//
// Purpose: The caregiver Home tab: "<name>'s week" with the account button, the calendar card
// (seven-day week strip), the Alerts section (tasks that were escalated or missed, with an
// "I'm on it" button for editors) and the "This week" schedule. Everything comes from the
// shared day view state owned by CaregiverApp. While the first load is pending it shows a
// spinner, and if it fails with nothing cached, the error message.
//
// Last modified: 2026-10-30

import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineMark } from '../components/DayComponents';
import type { DayViewState } from '../day/useDayView';
import { colors } from '../theme/colors';
import {
  AlertCard,
  CalendarCard,
  ScheduleCard,
  ScreenHeader,
  SectionTitle,
} from './CaregiverComponents';
import { buildSchedule, buildWeekStrip, selectAlerts, weekRangeLabel } from './format';
import { tabBarClearance, type } from './typography';
import { useClaimTasks } from './useClaimTasks';

/** Props for CaregiverHomeScreen. */
interface CaregiverHomeScreenProps {
  dayView: DayViewState;
  /** Whether this caregiver may claim alerts (everyone but viewers). */
  canClaim: boolean;
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
 * @param props: (CaregiverHomeScreenProps) The shared day view, the claim permission and the
 *        account button handler.
 * @return: (JSX.Element) The screen.
 */
export function CaregiverHomeScreen({
  dayView,
  canClaim,
  onAccountPress,
}: CaregiverHomeScreenProps) {
  const { day, errorMessage, isOffline } = dayView;
  const insets = useSafeAreaInsets();
  const { claims, claim } = useClaimTasks();
  const alerts = day === null ? [] : selectAlerts(day.tasks);

  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 8, paddingBottom: tabBarClearance(insets.bottom) },
      ]}
    >
      {day === null ? (
        <>
          <ScreenHeader
            title="This week"
            subtitle=""
            trailing={<AccountButton onPress={onAccountPress} />}
          />
          {errorMessage !== null ? (
            <Text style={[type.callout, styles.message]}>{errorMessage}</Text>
          ) : (
            <ActivityIndicator size="large" color={colors.secondaryText} />
          )}
        </>
      ) : (
        <>
          <ScreenHeader
            title={`${day.seniorPreferredName}'s week`}
            subtitle={weekRangeLabel(day.localDate)}
            trailing={<AccountButton onPress={onAccountPress} />}
          />
          <CalendarCard todayLocalDate={day.localDate} days={buildWeekStrip(day)} />
          <View style={styles.section}>
            <SectionTitle text="Alerts" />
            {alerts.length === 0 && (
              <Text style={[type.callout, styles.message]}>Nothing needs attention.</Text>
            )}
            {alerts.map((task) => (
              <AlertCard
                key={task.instanceId}
                task={task}
                claim={claims[task.instanceId]}
                canClaim={canClaim}
                onClaim={() => void claim(task.instanceId)}
              />
            ))}
          </View>
          <View style={styles.section}>
            <SectionTitle text="This week" />
            <ScheduleCard groups={buildSchedule(day)} />
          </View>
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
