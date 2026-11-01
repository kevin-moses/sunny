// sunny_app/src/caregiver/CaregiverHomeScreen.tsx
//
// Purpose: The caregiver Home tab: "<name>'s week" with the account button, then, in order: the
// Alerts section (tasks that were escalated or missed, with "I'm on it" and "Mark done" buttons
// for editors, or who is already on it), "Today's tasks" (a "Leftover" group of yesterday's open
// tasks, then today's tasks in time order; editors tap a task's checkbox to mark it done at once
// and tap its text to open an inline note editor, one at a time; viewers can open a note to read
// it), the calendar card (seven-day week strip whose cells choose the day shown; the dots mean
// events) with the selected day's events directly below it (events only, never tasks), and
// "Later this week", the events of the days after the selected one grouped by day (hidden when
// there are none). Everything comes from the shared day view state owned by CaregiverApp, and the
// derived lists are computed once per day view and selection. While the first load is pending it
// shows a spinner, and if it fails with nothing cached, the error message.
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TaskInstanceId } from '../backend/convexApi';
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
  eventsForDate,
  isAlert,
  laterThisWeek,
  resolveSelectedDate,
  todaysTasks,
  selectedDayTitle,
  weekRangeLabel,
  type DaySelection,
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
  const { day, errorMessage, isOffline } = dayView;
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { actions, claim, markDone, saveNote } = useTaskActions(userId);

  /** The row whose note is open; only one at a time. */
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);

  /**
   * purpose: Open a row's note, or close it when it is already open.
   * @param rowId: (string) The row's id.
   * @return: (void)
   */
  const toggleNote = (rowId: string): void =>
    setOpenNoteId((current) => (current === rowId ? null : rowId));

  /**
   * purpose: Save a task's note and close its editor once it is saved; a failure keeps the
   *          editor open with the error under the row.
   * @param instanceId: (TaskInstanceId) The task instance.
   * @param note: (string | undefined) The trimmed note; undefined clears it.
   * @return: (void)
   */
  const saveTaskNote = (instanceId: TaskInstanceId, note: string | undefined): void => {
    void saveNote(instanceId, note).then((saved) => {
      if (saved) setOpenNoteId(null);
    });
  };

  const [selection, setSelection] = useState<DaySelection | null>(null);
  const view = useMemo(() => {
    if (day === null) return null;
    const strip = buildWeekStrip(day);
    const selectedDate = resolveSelectedDate(strip, day.localDate, selection);
    const { leftover, today } = todaysTasks(day, userId);
    return {
      alerts: day.tasks.filter(isAlert).map((task) => ({ task, message: alertMessage(task) })),
      strip,
      selectedDate,
      scheduleTitle: selectedDayTitle(day.localDate, selectedDate),
      leftover,
      todayTasks: today,
      events: eventsForDate(day, selectedDate),
      later: laterThisWeek(day, strip, selectedDate),
      range: weekRangeLabel(day.localDate),
    };
  }, [day, selection, userId]);

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
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
                onMarkDone={() => void markDone(task.instanceId)}
              />
            ))}
          </View>
          <View style={styles.section}>
            <SectionTitle text="Today's tasks" />
            <ScheduleCard
              leftover={view.leftover}
              rows={view.todayTasks}
              emptyText="No tasks today."
              canEdit={canEdit}
              actions={actions}
              openNoteId={openNoteId}
              onMarkDone={(instanceId) => void markDone(instanceId)}
              onToggleNote={toggleNote}
              onSaveNote={saveTaskNote}
            />
          </View>
          <View style={styles.section}>
            <CalendarCard
              todayLocalDate={day.localDate}
              days={view.strip}
              selectedDate={view.selectedDate}
              onSelect={(date) => setSelection({ date, todayWhenChosen: day.localDate })}
            />
            <SectionTitle text={view.scheduleTitle} />
            <ScheduleCard
              leftover={[]}
              rows={view.events}
              emptyText="No events."
              canEdit={canEdit}
              actions={actions}
              openNoteId={openNoteId}
              onMarkDone={(instanceId) => void markDone(instanceId)}
              onToggleNote={toggleNote}
              onSaveNote={saveTaskNote}
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
