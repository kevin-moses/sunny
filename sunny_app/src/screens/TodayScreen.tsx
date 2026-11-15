import { useConvexConnectionState } from 'convex/react';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AgendaList,
  DoneCard,
  NextUpCard,
  OfflineMark,
  OrientationHeader,
  UpcomingList,
} from '../components/DayComponents';
import { buildAgenda } from '../day/format';
import { confirmQueue } from '../day/pendingConfirms';
import { applyPending } from '../day/pendingEntries';
import type { DayViewState } from '../day/useDayView';
import { dayIsCurrent, doneTarget, STALE_DAY_MESSAGE, useDoneAction } from '../day/useDoneAction';
import { usePendingConfirms } from '../day/usePendingConfirms';
import { useTick } from '../day/useTick';
import { colors, GRID } from '../theme/colors';
import { TalkButton } from '../voice/TalkButton';

const TICK_MS = 30_000;

const REGULAR_WIDTH = 768;

export function TodayScreen({ dayView }: { dayView: DayViewState }) {
  const { day, errorMessage, isOffline } = dayView;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isWebSocketConnected } = useConvexConnectionState();
  const now = useTick(TICK_MS);
  const pending = usePendingConfirms(confirmQueue);
  const tasks = useMemo(() => applyPending(day?.tasks ?? [], pending), [day, pending]);
  const agenda = useMemo(
    () =>
      pending.length === 0 ? dayView.agenda : buildAgenda(day === null ? null : { ...day, tasks }),
    [dayView.agenda, pending, day, tasks],
  );
  const stale = day !== null && !dayIsCurrent(day, now);
  const target = stale ? null : doneTarget(tasks, isWebSocketConnected);
  const done = useDoneAction(target, isOffline, confirmQueue, tasks);
  const undo = done.undo === null ? null : { ...done.undo, onPress: done.pressUndo };
  const horizontal = width >= REGULAR_WIDTH ? 24 * GRID : 6 * GRID;

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{
          gap: 8 * GRID,
          paddingHorizontal: horizontal,
          paddingTop: insets.top + 6 * GRID,
          paddingBottom: 6 * GRID,
        }}
      >
        {day !== null ? (
          <>
            <OrientationHeader day={day} />
            <DoneCard
              task={done.task}
              message={done.message ?? (stale ? STALE_DAY_MESSAGE : null)}
              onPress={done.pressDone}
              undo={undo}
            />
            {day.nextUp !== null && <NextUpCard event={day.nextUp} today={day.localDate} />}
            <AgendaList items={agenda} />
            <UpcomingList events={day.upcoming} today={day.localDate} />
            {isOffline && <OfflineMark />}
          </>
        ) : errorMessage !== null ? (
          <Text style={styles.message}>{errorMessage}</Text>
        ) : (
          <ActivityIndicator size="large" color={colors.secondaryText} />
        )}
      </ScrollView>
      <View
        style={{ paddingHorizontal: 6 * GRID, paddingBottom: Math.max(insets.bottom, 2 * GRID) }}
      >
        <TalkButton />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  message: { fontSize: 20, color: colors.text },
});
