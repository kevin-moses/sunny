// sunny_app/src/screens/DisplayScreen.tsx
//
// Purpose: The home display, run on an iPad until the e-ink hardware exists. The iPad is laid
// out like the device: a paper panel (the e-ink screen, drawn at the 1194 x 834 design size
// and scaled as a whole to fit) on a dark body, with the Done and Talk keys apart from the
// screen's content (KeyPanel): a column to the panel's right in landscape (Done on top), a row
// below it in portrait. The display is meant to stand in landscape; portrait is laid out rather
// than locked because iPadOS 26 no longer reliably honors an orientation lock.
//
// The panel is a carousel of two screens, switched every CAROUSEL_MS with no motion: Now (the
// Now card and Next up) and Today (the day's rows, the waiting task boxed). A newly due task
// and any key press bring Now back and restart the timer; during a multi-step task the
// carousel holds on Now so the current step stays in view. Nothing on the panel itself is
// pressable. Keeps the screen awake with the status bar hidden. The day view comes from the app
// shell (see useDayView).
//
// Last modified: 2026-11-09

import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { DayViewState } from '../day/useDayView';
import { DisplayCanvas, DisplayMessage, NowBody, TodayBody } from '../display/DisplayParts';
import { KEY_ROW_HEIGHT, KEY_WIDTH, KeyPanel } from '../display/KeyPanel';
import { nextItem, nowCard, todayRows } from '../display/model';
import { CANVAS, ink, useDisplayFonts } from '../display/theme';
import { useDisplayKeys } from '../display/useDisplayKeys';

/** How long (ms) each carousel screen stays up. */
const CAROUSEL_MS = 45_000;

/** Space (points) inside the safe area around the panel and keys, and between them. */
const MARGIN = 16;

/** The carousel's screens. */
type Page = 'now' | 'today';

/**
 * purpose: Full-screen home display for a paired iPad.
 * @param props: ({ dayView: DayViewState }) The household's day view, loaded by the app shell.
 * @return: (JSX.Element) The screen.
 */
export function DisplayScreen({ dayView }: { dayView: DayViewState }) {
  useKeepAwake();
  const fontsReady = useDisplayFonts();
  const { day, agenda, errorMessage, isOffline } = dayView;
  const card = useMemo(() => (day === null ? null : nowCard(day)), [day]);
  const taskCard = card?.kind === 'task' ? card : null;
  const nowTaskId = taskCard?.task.instanceId ?? null;

  const [page, setPage] = useState<Page>('now');
  const [cycle, setCycle] = useState(0);
  /**
   * purpose: Show the Now page and restart the carousel timer.
   * @return: (void)
   */
  const showNow = (): void => {
    setPage('now');
    setCycle((c) => c + 1);
  };
  // A newly due task brings the Now page forward (state adjusted during render, React's
  // pattern for following a changing value).
  const [seenTaskId, setSeenTaskId] = useState(nowTaskId);
  if (seenTaskId !== nowTaskId) {
    setSeenTaskId(nowTaskId);
    if (nowTaskId !== null) showNow();
  }
  // In the middle of a multi-step task the current step stays on screen.
  const hold = taskCard?.steps != null;
  useEffect(() => {
    if (hold) return undefined;
    const timer = setInterval(() => setPage((p) => (p === 'now' ? 'today' : 'now')), CAROUSEL_MS);
    return () => clearInterval(timer);
  }, [hold, cycle]);
  const shown: Page = hold ? 'now' : page;

  const keys = useDisplayKeys(taskCard, showNow);

  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const placement = height > width ? 'below' : 'right';
  const right = placement === 'right';
  // The root pads by the safe area plus MARGIN on every side, and MARGIN separates the panel
  // from the keys, so this is the room left for the panel. Never below 0: a negative scale
  // would mirror the panel.
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

  // Text laid out before its font registers keeps the fallback font, so wait for the fonts.
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
        <NowBody card={card} step={keys.step} next={nextItem(day, agenda, nowTaskId)} />
      </DisplayCanvas>
    );
  }

  const status =
    keys.message ?? (keys.talkBusy ? 'Connecting to Sunny' : isOffline ? 'Not connected' : null);

  return (
    <View style={[styles.root, padding, { flexDirection: right ? 'row' : 'column' }]}>
      <StatusBar hidden />
      <View style={{ width: panelWidth, height: panelHeight, overflow: 'hidden' }}>
        <View style={{ transform: [{ scale }], transformOrigin: 'top left' }}>{panel}</View>
      </View>
      <KeyPanel
        placement={placement}
        length={right ? panelHeight : panelWidth}
        status={status}
        doneBusy={keys.doneBusy}
        talkBusy={keys.talkBusy}
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
