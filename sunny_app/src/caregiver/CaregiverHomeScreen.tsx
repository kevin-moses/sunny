import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

interface CaregiverHomeScreenProps {
  dayView: DayViewState;
  canEdit: boolean;
  userId: string | null;
  onAccountPress: () => void;
}

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
  const { actions, claim, markDone, undoMarkDone, reopen, saveNote } = useTaskActions(userId);
  const noteEditor = useNoteEditor(saveNote);
  const { id: toastId, show: showToast, dismiss: dismissToast } = useUndoToast<TaskInstanceId>();
  const toastIdRef = useRef<TaskInstanceId | null>(null);
  const [selection, setSelection] = useState<DaySelection | null>(null);
  const todayDate = day?.localDate ?? null;

  const tick = useCallback(
    (id: TaskInstanceId): void => {
      tapHaptic();
      void markDone(id).then((marked) => {
        if (marked) showToast(id);
      });
    },
    [markDone, showToast],
  );

  const undo = useCallback((): void => {
    if (toastId === null) return;
    undoHaptic();
    dismissToast();
    void undoMarkDone(toastId);
  }, [toastId, dismissToast, undoMarkDone]);

  const selectDay = useCallback(
    (date: string): void => {
      if (todayDate !== null) setSelection({ date, todayWhenChosen: todayDate });
    },
    [todayDate],
  );

  useEffect(() => {
    toastIdRef.current = toastId;
  }, [toastId]);

  const reopenTask = useCallback(
    (id: TaskInstanceId): void => {
      if (toastIdRef.current === id) dismissToast();
      void reopen(id);
    },
    [dismissToast, reopen],
  );

  const rowActions = useMemo<TaskRowActions>(
    () => ({ states: actions, markDone: tick, reopen: reopenTask }),
    [actions, tick, reopenTask],
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
                <PlannedTasksCard
                  rows={selected.planned}
                  emptyText="No tasks."
                  dayTitle={selected.title}
                />
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
