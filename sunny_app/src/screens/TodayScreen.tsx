// sunny_app/src/screens/TodayScreen.tsx
//
// Purpose: The senior phone's home screen: the day clock (orientation header, Next up,
// today's tasks and events, the coming week) from calendar.dayView, with the Talk button at
// the bottom. The day view state comes from the app shell (see useDayView), so it survives
// a conversation.
//
// Last modified: 2026-10-29

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
  NextUpCard,
  OfflineMark,
  OrientationHeader,
  UpcomingList,
} from '../components/DayComponents';
import type { DayViewState } from '../day/useDayView';
import { colors, GRID } from '../theme/colors';
import { TalkButton } from '../voice/TalkButton';

/** Width (points) from which the phone layout uses the wide, tablet-style margins. */
const REGULAR_WIDTH = 768;

/**
 * purpose: Today screen for a paired senior phone.
 * @param props: ({ dayView: DayViewState }) The household's day view, loaded by the app shell.
 * @return: (JSX.Element) The screen.
 */
export function TodayScreen({ dayView }: { dayView: DayViewState }) {
  const { day, agenda, errorMessage, isOffline } = dayView;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
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
