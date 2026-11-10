// sunny_app/src/screens/TodayScreen.tsx
//
// Purpose: The senior phone's home screen: the day clock (orientation header, Next up,
// today's tasks and events, the coming week) from calendar.dayView, with the Talk button at
// the bottom. The day view state comes from the app shell (see useDayView), so it survives
// a conversation. When a task is due (or may be confirmed early, up to an hour ahead), a Done
// card sits under the header (the task's label, its due time if early, and one large Done
// button, see useDoneAction). Done presses go through a durable queue (pendingConfirms), so they
// work offline; queued tasks show as checked at once. Offline across midnight the cached day is
// yesterday's: then no Done card is offered and a calm line says today's list is loading; an
// early task is only offered while the socket is connected. Talk stays fixed at the bottom, far
// from it.
//
// Last modified: 2026-11-09

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
import { applyPending, confirmQueue } from '../day/pendingConfirms';
import type { DayViewState } from '../day/useDayView';
import { dayIsCurrent, doneTarget, STALE_DAY_MESSAGE, useDoneAction } from '../day/useDoneAction';
import { usePendingConfirms } from '../day/usePendingConfirms';
import { useTick } from '../day/useTick';
import { colors, GRID } from '../theme/colors';
import { TalkButton } from '../voice/TalkButton';

/** How often (ms) the screen re-checks whether the cached day is still today's. */
const TICK_MS = 30_000;

/** Width (points) from which the phone layout uses the wide, tablet-style margins. */
const REGULAR_WIDTH = 768;

/**
 * purpose: Today screen for a paired senior phone: the day clock, the Done card for the task
 *          to confirm (the due one, else one that may be confirmed early; hidden when there is
 *          none or just after a press) and the Talk button. Tasks with a queued Done press show
 *          as checked at once, also offline and after a restart.
 * @param props: ({ dayView: DayViewState }) The household's day view, loaded by the app shell.
 * @return: (JSX.Element) The screen.
 */
export function TodayScreen({ dayView }: { dayView: DayViewState }) {
  const { day, errorMessage, isOffline } = dayView;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isWebSocketConnected } = useConvexConnectionState();
  const now = useTick(TICK_MS);
  const pendingIds = usePendingConfirms(confirmQueue);
  const tasks = useMemo(() => applyPending(day?.tasks ?? [], pendingIds), [day, pendingIds]);
  const agenda = useMemo(
    () =>
      pendingIds.size === 0 ? dayView.agenda : buildAgenda(day === null ? null : { ...day, tasks }),
    [dayView.agenda, pendingIds, day, tasks],
  );
  const stale = day !== null && !dayIsCurrent(day, now);
  const target = stale ? null : doneTarget(tasks, isWebSocketConnected);
  const done = useDoneAction(target, isOffline, confirmQueue);
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
