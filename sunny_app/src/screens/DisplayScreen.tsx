// sunny_app/src/screens/DisplayScreen.tsx
//
// Purpose: The home display, run on an iPad until the e-ink hardware exists. The iPad is laid
// out like the device: a paper panel (the e-ink screen, drawn at the 1194 x 834 design size
// and scaled as a whole to fit) on a dark body, with the Done and Talk keys apart from the
// screen's content (KeyPanel): a column to the panel's right in landscape (Done on top), a row
// below it in portrait. The display is meant to stand in landscape; portrait is laid out rather
// than locked because iPadOS 26 no longer reliably honors an orientation lock.
//
// The panel is a carousel of two screens, switched every tuned carouselMs (display/tuning.ts)
// with no motion: Now (the Now card and Next up) and Today (the day's rows, the waiting task
// boxed). A newly due task
// and any key press bring Now back and restart the timer; during a multi-step task, a voice
// session or while an answer lingers, the carousel holds on Now so it stays in view. Nothing on
// the panel itself is pressable. Keeps the screen awake with the status bar hidden. The day
// view comes from the app shell (see useDayView).
//
// Voice stays on the panel (useDisplayVoice): Talk opens a session and the voice card shows
// listening, thinking and the answer, which lingers a few minutes after the session ends. A
// newly due task clears a lingering answer. The due cue (useDueCue) chimes and speaks a task's
// prompt when it comes due and on each reprompt, but never during a voice session.
// Foreground notification banners and sounds are silenced (useQuietNotifications) since the
// cue covers the same prompts. The status line between the keys shows the last key's or the
// voice session's message, "Press Talk to stop" during a session, or "Not connected".
//
// Last modified: 2026-11-09

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
import { CANVAS, ink, useDisplayFonts } from '../display/theme';
import { useTuning } from '../display/TuningProvider';
import { useDisplayKeys } from '../display/useDisplayKeys';
import { useDisplayVoice } from '../display/useDisplayVoice';
import { useDueCue } from '../display/useDueCue';
import { useQuietNotifications } from '../display/useQuietNotifications';
import { useStatusMessage } from '../display/useStatusMessage';

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
  useQuietNotifications();
  const fontsReady = useDisplayFonts();
  const { day, agenda, errorMessage, isOffline } = dayView;
  const card = useMemo(() => (day === null ? null : nowCard(day)), [day]);
  const taskCard = card?.kind === 'task' ? card : null;
  const nowTaskId = taskCard?.task.instanceId ?? null;
  const status = useStatusMessage();
  const voice = useDisplayVoice(day === null ? null : nowTime(day), isOffline, status.show);
  const { carouselMs } = useTuning();

  const [page, setPage] = useState<Page>('now');
  const [cycle, setCycle] = useState(0);
  /**
   * purpose: Show the Now page and restart the carousel timer.
   * @return: (void)
   */
  const showNow = useCallback((): void => {
    setPage('now');
    setCycle((c) => c + 1);
  }, []);
  // A newly due task brings the Now page forward and takes over from a lingering answer
  // (state adjusted during render, React's pattern for following a changing value).
  const [seenTaskId, setSeenTaskId] = useState(nowTaskId);
  if (seenTaskId !== nowTaskId) {
    setSeenTaskId(nowTaskId);
    if (nowTaskId !== null) {
      showNow();
      voice.dismissAnswer();
    }
  }
  const { dismissAnswer } = voice;
  /**
   * purpose: A due cue started: bring its task forward, ahead of any lingering answer.
   * @return: (void)
   */
  const onCue = useCallback((): void => {
    showNow();
    dismissAnswer();
  }, [showNow, dismissAnswer]);
  useDueCue(day?.tasks ?? null, voice.active, onCue);

  // A multi-step task's current step, a voice session and a lingering answer stay on screen.
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
        <NowBody
          card={card}
          step={keys.step}
          next={nextItem(day, agenda, nowTaskId)}
          voice={voice.card}
        />
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
