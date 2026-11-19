import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { DayViewState } from '../day/useDayView';
import { DisplayCanvas, DisplayMessage, NowBody, TodayBody } from '../display/DisplayParts';
import { KEY_ROW_HEIGHT, KEY_WIDTH, KeyPanel } from '../display/KeyPanel';
import { nextItem, nowCard, nowTime, todayRows } from '../display/model';
import { CANVAS, ink, usePaperFonts } from '../display/theme';
import { useTuning } from '../display/TuningProvider';
import { useDisplayKeys } from '../display/useDisplayKeys';
import { useDisplayVoice } from '../display/useDisplayVoice';
import { useDueCue } from '../display/useDueCue';
import { useQuietNotifications } from '../display/useQuietNotifications';
import { useStatusMessage } from '../display/useStatusMessage';

const MARGIN = 16;

type Page = 'now' | 'today';

export function DisplayScreen({ dayView }: { dayView: DayViewState }) {
  useKeepAwake();
  useQuietNotifications();
  const fontsReady = usePaperFonts();
  const { day, agenda, errorMessage, isOffline } = dayView;
  const card = useMemo(() => (day === null ? null : nowCard(day)), [day]);
  const taskCard = card?.kind === 'task' ? card : null;
  const nowTaskId = taskCard?.task.instanceId ?? null;
  const status = useStatusMessage();
  const voice = useDisplayVoice(day === null ? null : nowTime(day), isOffline, status.show);
  const { carouselMs } = useTuning();

  const [page, setPage] = useState<Page>('now');
  const [cycle, setCycle] = useState(0);
  const showNow = useCallback((): void => {
    setPage('now');
    setCycle((c) => c + 1);
  }, []);
  const [seenTaskId, setSeenTaskId] = useState(nowTaskId);
  if (seenTaskId !== nowTaskId) {
    setSeenTaskId(nowTaskId);
    if (nowTaskId !== null) {
      showNow();
      voice.dismissAnswer();
    }
  }
  const { dismissAnswer } = voice;
  const onCue = useCallback((): void => {
    showNow();
    dismissAnswer();
  }, [showNow, dismissAnswer]);
  useDueCue(day?.tasks ?? null, voice.active, onCue);

  const hold = taskCard?.steps != null || voice.card !== null;
  useEffect(() => {
    if (hold) return undefined;
    const timer = setInterval(() => setPage((p) => (p === 'now' ? 'today' : 'now')), carouselMs);
    return () => clearInterval(timer);
  }, [hold, cycle, carouselMs]);
  const shown: Page = hold ? 'now' : page;

  const keys = useDisplayKeys(taskCard, showNow, status.show, voice.talk);

  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const placement = height > width ? 'below' : 'right';
  const right = placement === 'right';
  const roomWidth = width - insets.left - insets.right - 2 * MARGIN;
  const roomHeight = height - insets.top - insets.bottom - 2 * MARGIN;
  const scale = Math.max(
    0,
    Math.min(
      (roomWidth - (right ? KEY_WIDTH + MARGIN : 0)) / CANVAS.width,
      (roomHeight - (right ? 0 : KEY_ROW_HEIGHT + MARGIN)) / CANVAS.height,
    ),
  );
  const padding = {
    paddingTop: insets.top + MARGIN,
    paddingBottom: insets.bottom + MARGIN,
    paddingLeft: insets.left + MARGIN,
    paddingRight: insets.right + MARGIN,
  };
  const panelWidth = CANVAS.width * scale;
  const panelHeight = CANVAS.height * scale;

  if (!fontsReady) return <View style={styles.root} />;

  let panel: ReactElement;
  if (day === null || card === null) {
    panel = <DisplayMessage text={errorMessage ?? 'Loading...'} />;
  } else if (shown === 'today') {
    const { rows, hidden } = todayRows(agenda, nowTaskId);
    panel = (
      <DisplayCanvas day={day}>
        <TodayBody rows={rows} hidden={hidden} />
      </DisplayCanvas>
    );
  } else {
    panel = (
      <DisplayCanvas day={day}>
        <NowBody card={card} next={nextItem(day, agenda, nowTaskId)} voice={voice.card} />
      </DisplayCanvas>
    );
  }

  const statusLine = status.message ?? voice.status ?? (isOffline ? 'Not connected' : null);

  return (
    <View style={[styles.root, padding, { flexDirection: right ? 'row' : 'column' }]}>
      <StatusBar hidden />
      <View style={{ width: panelWidth, height: panelHeight, overflow: 'hidden' }}>
        <View style={{ transform: [{ scale }], transformOrigin: 'top left' }}>{panel}</View>
      </View>
      <KeyPanel
        placement={placement}
        length={right ? panelHeight : panelWidth}
        status={statusLine}
        doneBusy={keys.doneBusy}
        onDone={keys.pressDone}
        onTalk={keys.pressTalk}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: MARGIN,
    backgroundColor: ink.bezel,
  },
});
