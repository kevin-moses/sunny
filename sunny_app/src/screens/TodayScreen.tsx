import { useConvexConnectionState } from 'convex/react';
import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { buildAgenda } from '../day/format';
import { confirmQueue } from '../day/pendingConfirms';
import { applyPending, overlayEntries } from '../day/pendingEntries';
import type { DayViewState } from '../day/useDayView';
import { dayIsCurrent, doneTarget, STALE_DAY_MESSAGE, useDoneAction } from '../day/useDoneAction';
import { usePendingConfirms } from '../day/usePendingConfirms';
import { useTick } from '../day/useTick';
import { dayRows, nextLine, screenMode } from '../phone/model';
import {
  DayList,
  DoneSlot,
  HeadlineSlot,
  MessageSlot,
  OfflineNote,
  TagRow,
} from '../phone/PhoneParts';
import { layout, paper, usePhoneFonts } from '../phone/theme';
import { TalkButton } from '../voice/TalkButton';
import { useUnsentWidgetPresses } from '../widget/sharedPresses';

const TICK_MS = 30_000;

export function TodayScreen({ dayView }: { dayView: DayViewState }) {
  const { day, errorMessage, isOffline } = dayView;
  const insets = useSafeAreaInsets();
  const fontsReady = usePhoneFonts();
  const { isWebSocketConnected } = useConvexConnectionState();
  const now = useTick(TICK_MS);
  const queued = usePendingConfirms(confirmQueue);
  const elsewhere = useUnsentWidgetPresses();
  const pressed = useMemo(() => overlayEntries(queued, elsewhere), [queued, elsewhere]);
  const tasks = useMemo(() => applyPending(day?.tasks ?? [], pressed), [day, pressed]);
  const agenda = useMemo(
    () =>
      pressed.length === 0 ? dayView.agenda : buildAgenda(day === null ? null : { ...day, tasks }),
    [dayView.agenda, pressed, day, tasks],
  );
  const stale = day !== null && !dayIsCurrent(day, now);
  const target = stale ? null : doneTarget(tasks, isWebSocketConnected);
  const done = useDoneAction(target, isOffline, confirmQueue, tasks);
  const ready = fontsReady && day !== null;
  const mode = ready
    ? screenMode({
        task: done.task,
        message: done.message ?? (stale ? STALE_DAY_MESSAGE : null),
        undo: done.undo,
        next: stale ? null : nextLine(day, agenda, now),
        timezone: day.timezone,
      })
    : null;
  const shown = mode?.kind === 'task' ? mode.task : null;

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
      <View style={styles.column}>
        {isOffline && <OfflineNote />}
        <TagRow mode={mode} />
        {mode !== null ? (
          <>
            <HeadlineSlot mode={mode} onUndo={done.pressUndo} />
            <DoneSlot mode={mode} onDone={done.pressDone} />
            <DayList rows={dayRows(agenda, shown, now)} />
          </>
        ) : (
          <>
            {fontsReady && errorMessage !== null ? (
              <MessageSlot text={errorMessage} />
            ) : (
              <ActivityIndicator size="large" color={paper.ink} style={styles.loading} />
            )}
            <View style={styles.rest} />
          </>
        )}
        <TalkButton />
      </View>
    </View>
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
