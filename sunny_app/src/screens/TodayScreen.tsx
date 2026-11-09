// sunny_app/src/screens/TodayScreen.tsx
//
// Purpose: The senior phone's home screen: the day clock (orientation header, Next up,
// today's tasks and events, the coming week) from calendar.dayView, with the Talk button at
// the bottom. The day view state comes from the app shell (see useDayView), so it survives
// a conversation. When a task is due, a Done card sits under the header (the task's label and
// one large Done button, see useDoneAction); Talk stays fixed at the bottom, far from it.
//
// Last modified: 2026-11-09

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
import { doneTarget, useDoneAction } from '../day/useDoneAction';
import type { DayViewState } from '../day/useDayView';
import { colors, GRID } from '../theme/colors';
import { TalkButton } from '../voice/TalkButton';

/** Width (points) from which the phone layout uses the wide, tablet-style margins. */
const REGULAR_WIDTH = 768;

/**
 * purpose: Today screen for a paired senior phone: the day clock, the Done card for the task
 *          that is due (hidden when nothing is due or just after a confirm) and the Talk button.
 * @param props: ({ dayView: DayViewState }) The household's day view, loaded by the app shell.
 * @return: (JSX.Element) The screen.
 */
export function TodayScreen({ dayView }: { dayView: DayViewState }) {
  const { day, agenda, errorMessage, isOffline } = dayView;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const target = doneTarget(day?.tasks ?? []);
  const done = useDoneAction(target, isOffline);
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
              busy={done.busy}
              message={done.message}
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
