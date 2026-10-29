// sunny_app/src/screens/DisplayScreen.tsx
//
// Purpose: The home display, stubbed on an iPad until the e-ink hardware exists: a calm,
// glanceable day clock in very large type (orientation header, Next up, today's list,
// the coming week) and the fixed going-out strip at the bottom. Nothing to configure on
// the device. Keeps the screen awake with the status bar hidden. The day view state comes
// from the app shell (see useDayView). Two columns in landscape (width > height), one in
// portrait.
//
// Last modified: 2026-10-28

import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  AgendaList,
  NextUpCard,
  OfflineMark,
  OrientationHeader,
  UpcomingList,
} from '../components/DayComponents';
import type { AgendaItem, DayViewData } from '../day/types';
import type { DayViewState } from '../day/useDayView';
import { colors, ROUNDED_FONT } from '../theme/colors';

/**
 * purpose: The fixed reminder at the bottom of the display; always visible, nothing to press.
 * @return: (JSX.Element) The strip.
 */
function GoingOutStrip() {
  return (
    <View
      accessible
      accessibilityLabel="Going out? Take your wallet, keys, glasses and phone."
      style={styles.strip}
    >
      <Text style={styles.stripText}>Going out? Wallet · Keys · Glasses · Phone</Text>
    </View>
  );
}

/**
 * purpose: Full-screen day clock for a paired home display.
 * @param props: ({ dayView: DayViewState }) The household's day view, loaded by the app shell.
 * @return: (JSX.Element) The screen.
 */
export function DisplayScreen({ dayView }: { dayView: DayViewState }) {
  useKeepAwake();
  const { day, agenda, errorMessage, isOffline } = dayView;
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <ScrollView contentContainerStyle={styles.content}>
        {day !== null ? (
          <DayBody day={day} agenda={agenda} landscape={landscape} />
        ) : (
          <View style={styles.centered}>
            <Text style={styles.loading}>{errorMessage ?? 'Loading...'}</Text>
          </View>
        )}
        <GoingOutStrip />
      </ScrollView>
      {isOffline && day !== null && (
        <View style={styles.offline}>
          <OfflineMark />
        </View>
      )}
    </View>
  );
}

/**
 * purpose: The day clock body: header, then the Next up card, today's agenda and the coming
 *          week, in two columns in landscape and one in portrait.
 * @param props: ({ day, agenda, landscape }) The day, its agenda, and whether to use two columns.
 * @return: (JSX.Element) The body.
 */
function DayBody({
  day,
  agenda,
  landscape,
}: {
  day: DayViewData;
  agenda: AgendaItem[];
  landscape: boolean;
}) {
  const nextUp = day.next_up !== null && (
    <NextUpCard event={day.next_up} today={day.local_date} scale={1.5} />
  );
  const agendaList = <AgendaList items={agenda} scale={1.5} />;
  const upcoming = (
    <UpcomingList events={day.upcoming.slice(0, 4)} today={day.local_date} scale={1.4} />
  );
  return (
    <View style={styles.body}>
      <OrientationHeader day={day} scale={2} />
      {landscape ? (
        <View style={styles.columns}>
          <View style={styles.column}>
            {nextUp}
            {upcoming}
          </View>
          <View style={styles.column}>{agendaList}</View>
        </View>
      ) : (
        <>
          {nextUp}
          {agendaList}
          {upcoming}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, padding: 48, gap: 32 },
  body: { flex: 1, gap: 32 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 48 },
  column: { flex: 1, gap: 32 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loading: { fontFamily: ROUNDED_FONT, fontSize: 36, color: colors.text, textAlign: 'center' },
  strip: {
    alignSelf: 'stretch',
    paddingVertical: 20,
    borderRadius: 16,
    backgroundColor: colors.overlayFaint,
  },
  stripText: {
    fontFamily: ROUNDED_FONT,
    fontSize: 30,
    fontWeight: '600',
    textAlign: 'center',
    color: colors.text,
  },
  offline: { position: 'absolute', top: 24, right: 24 },
});
