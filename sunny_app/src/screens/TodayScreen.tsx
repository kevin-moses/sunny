import { useConvexConnectionState } from 'convex/react';
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { buildAgenda } from '../day/format';
import { applyPresses, overlayEntries } from '../day/pressOverlay';
import type { DayViewState } from '../day/useDayView';
import { dayIsCurrent, doneTarget, STALE_DAY_MESSAGE, useDoneAction } from '../day/useDoneAction';
import { useTick } from '../day/useTick';
import { usePaperFonts } from '../display/theme';
import { dayRows, nextLine, screenMode } from '../phone/model';
import {
  DayList,
  DoneSlot,
  HeadlineSlot,
  MessageSlot,
  OfflineNote,
  TagRow,
} from '../phone/PhoneParts';
import { layout, paper } from '../phone/theme';
import { TalkButton } from '../voice/TalkButton';
import { phonePresses } from '../widget/pressStore';

const TICK_MS = 30_000;

function Page({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top + layout.belowSafeTop,
          paddingBottom: insets.bottom + layout.aboveSafeBottom,
        },
      ]}
    >
      <View style={styles.column}>{children}</View>
    </View>
  );
}

function Waiting({ message }: { message: string | null }) {
  return (
    <>
      {message !== null ? (
        <MessageSlot text={message} />
      ) : (
        <ActivityIndicator size="large" color={paper.ink} style={styles.loading} />
      )}
      <View style={styles.rest} />
    </>
  );
}

export function TodayScreen({ dayView }: { dayView: DayViewState }) {
  const { day, errorMessage, isOffline } = dayView;
  const fontsReady = usePaperFonts();
  const { isWebSocketConnected } = useConvexConnectionState();
  const now = useTick(TICK_MS);
  const seen = useSyncExternalStore(phonePresses.subscribe, phonePresses.getSeen);
  const tasks = useMemo(() => {
    if (day === null) return [];
    const pressed = overlayEntries(seen.presses, day.answeredPresses ?? 0);
    return applyPresses(day.tasks, pressed, day.timezone);
  }, [day, seen]);
  const agenda = useMemo(() => buildAgenda(day === null ? null : { ...day, tasks }), [day, tasks]);
  const stale = day !== null && !dayIsCurrent(day, now);
  const target = stale ? null : doneTarget(tasks, isWebSocketConnected);
  const done = useDoneAction(target, isOffline, phonePresses, tasks);
  const shown = day === null ? null : done.task;
  const rows = useMemo(() => dayRows(agenda, shown, now), [agenda, shown, now]);

  if (!fontsReady) {
    return (
      <Page>
        <TagRow mode={null} />
        <Waiting message={null} />
      </Page>
    );
  }

  const mode =
    day === null
      ? null
      : screenMode({
          task: done.task,
          message: done.message ?? (stale ? STALE_DAY_MESSAGE : null),
          undo: done.undo,
          next: stale ? null : nextLine(day, agenda, done.task?.instanceId ?? null),
          timezone: day.timezone,
        });

  return (
    <Page>
      {isOffline && <OfflineNote />}
      <TagRow mode={mode} />
      {mode !== null ? (
        <>
          <HeadlineSlot mode={mode} onUndo={done.pressUndo} />
          <DoneSlot mode={mode} onDone={done.pressDone} />
          <DayList rows={rows} />
        </>
      ) : (
        <Waiting message={errorMessage} />
      )}
      <TalkButton />
    </Page>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: paper.paper },
  column: {
    flex: 1,
    gap: layout.gap,
    paddingTop: layout.columnTop,
    paddingHorizontal: layout.side,
  },
  loading: { height: layout.headline, alignSelf: 'flex-start' },
  rest: { flex: 1 },
});
