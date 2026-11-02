// sunny_app/src/caregiver/CaregiverHomeScreen.tsx
//
// Purpose: The caregiver Home tab: "<name>'s week" with the account button, then, in order: the
// Alerts section (tasks that were escalated or missed, with "I'm on it" and "Mark done" buttons
// for editors, or who is already on it), "Today's tasks" (a "Leftover" group of yesterday's open
// tasks, then today's tasks in time order; editors tick any open task's checkbox, which marks it
// done at once on the server and shows it checked, with a light haptic tap; for 5 seconds a
// "Task completed / Undo" toast offers to take it back (a selection click, and the server
// restores the task), only the latest tick has a toast; editors tap a task's text to open an
// autosaving inline note editor, one at a time; saved notes show as a subtitle), the calendar
// card (seven-day week strip whose cells choose the day shown; the dots mean events) with the
// selected day's section directly below it: for today, its events only (its tasks are the list
// above); for a later day, first that day's planned tasks in their own read-only card (dulled
// disabled checkboxes, "No tasks." when none), then its events in a separate card. Then "Later
// this week", the events of the days after the selected one grouped by day (hidden when there
// are none; events only).
// Everything comes from the shared day view state owned by CaregiverApp. The derived lists are
// computed in two memos: one per day view and user (tasks, alerts, the strip, the range) and one
// per day view and selection (the selected day's planned tasks and events, the later days, the title), and the
// memoized cards get stable callbacks. While the first load is pending it shows a spinner, and
// if it fails with nothing cached, the error message. The scroll view lifts the focused note
// editor above the keyboard (automaticallyAdjustKeyboardInsets) and dismisses the keyboard on
// drag, which closes (and saves) an open note.
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TaskInstanceId } from '../backend/convexApi';
import { OfflineMark } from '../components/DayComponents';
import type { DayViewState } from '../day/useDayView';
import { colors } from '../theme/colors';
import { type } from '../theme/typography';
import { useReduceMotion } from '../theme/useReduceMotion';
import {
  AlertCard,
  CalendarCard,
  EventsCard,
  LaterWeekCard,
  PlannedTasksCard,
  ScreenHeader,
  SectionTitle,
  TasksCard,
  type TaskRowActions,
} from './CaregiverComponents';
import {
  alertMessage,
  buildWeekStrip,
  eventsForDate,
  isAlert,
  laterThisWeek,
  plannedTasksForDate,
  resolveSelectedDate,
  todaysTasks,
  selectedDayTitle,
  weekRangeLabel,
  type DaySelection,
} from './format';
import { tapHaptic, undoHaptic } from './haptics';
import { useTabBarInset } from './tabBarInset';
import { UndoToast } from './UndoToast';
import { useNoteEditor } from './useNoteEditor';
import { useTaskActions } from './useTaskActions';
import { useUndoToast } from './useUndoToast';

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
  const reduceMotion = useReduceMotion();
  const { actions, claim, markDone, undoMarkDone, saveNote } = useTaskActions(userId);
  const noteEditor = useNoteEditor(saveNote);
  const { id: toastId, show: showToast, dismiss: dismissToast } = useUndoToast<TaskInstanceId>();
  const [selection, setSelection] = useState<DaySelection | null>(null);
  const todayDate = day?.localDate ?? null;

  /**
   * purpose: Tick a task: a light haptic tap at once, the server call, and the undo toast once
   *          the call succeeded (not when it failed or someone else had marked it done).
   * @param id: (TaskInstanceId) The task being ticked.
   * @return: (void)
   */
  const tick = useCallback(
    (id: TaskInstanceId): void => {
      tapHaptic();
      void markDone(id).then((marked) => {
        if (marked) showToast(id);
      });
    },
    [markDone, showToast],
  );

  /**
   * purpose: Undo the tick the toast is for, with a selection haptic, and hide the toast.
   * @return: (void)
   */
  const undo = useCallback((): void => {
    if (toastId === null) return;
    undoHaptic();
    dismissToast();
    void undoMarkDone(toastId);
  }, [toastId, dismissToast, undoMarkDone]);

  /**
   * purpose: Select a day of the week strip, remembering which "today" it was chosen against.
   * @param date: (string) The tapped cell's local date.
   * @return: (void)
   */
  const selectDay = useCallback(
    (date: string): void => {
      if (todayDate !== null) setSelection({ date, todayWhenChosen: todayDate });
    },
    [todayDate],
  );

  const rowActions = useMemo<TaskRowActions>(
    () => ({ states: actions, markDone: tick }),
    [actions, tick],
  );

  const view = useMemo(() => {
    if (day === null) return null;
    const { leftover, today } = todaysTasks(day, userId);
    return {
      alerts: day.tasks.filter(isAlert).map((task) => ({ task, message: alertMessage(task) })),
      strip: buildWeekStrip(day),
      leftover,
      todayTasks: today,
      range: weekRangeLabel(day.localDate),
    };
  }, [day, userId]);

  const strip = view?.strip ?? null;
  const selected = useMemo(() => {
    if (day === null || strip === null) return null;
    const selectedDate = resolveSelectedDate(strip, day.localDate, selection);
    return {
      selectedDate,
      title: selectedDayTitle(day.localDate, selectedDate),
      planned: plannedTasksForDate(day, selectedDate),
      events: eventsForDate(day, selectedDate),
      later: laterThisWeek(day, strip, selectedDate),
    };
  }, [day, strip, selection]);

  return (
    <View style={styles.fill}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
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
        {day === null || view === null || selected === null ? (
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
                  onClaim={claim}
                  onMarkDone={tick}
                />
              ))}
            </View>
            <View style={styles.section}>
              <SectionTitle text="Today's tasks" />
              <TasksCard
                leftover={view.leftover}
                today={view.todayTasks}
                canEdit={canEdit}
                rowActions={rowActions}
                noteEditor={noteEditor}
              />
            </View>
            <View style={styles.section}>
              <CalendarCard
                todayLocalDate={day.localDate}
                days={view.strip}
                selectedDate={selected.selectedDate}
                onSelect={selectDay}
              />
              <SectionTitle text={selected.title} />
              {selected.planned !== null && (
                <PlannedTasksCard rows={selected.planned} emptyText="No tasks." />
              )}
              <EventsCard rows={selected.events} emptyText="No events." />
            </View>
            {selected.later.length > 0 && (
              <View style={styles.section}>
                <SectionTitle text="Later this week" />
                <LaterWeekCard groups={selected.later} />
              </View>
            )}
            {isOffline && <OfflineMark />}
          </>
        )}
      </ScrollView>
      {toastId !== null && (
        <UndoToast bottom={tabBarInset} reduceMotion={reduceMotion} onUndo={undo} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, gap: 32 },
  section: { gap: 12 },
  message: { color: colors.secondaryText },
});
