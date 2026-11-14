// sunny_app/src/components/DayComponents.tsx
//
// Purpose: The building blocks of the senior phone's day clock: the orientation header
// ("Monday evening", date below, no minute clock), the Next up card, today's agenda and the
// coming week, the Done card (the task's label above one large Done button, a result line such
// as "press again", and for 30 seconds after a press the Undo line "<label> done." with an
// outlined secondary Undo button, the one line confirming the press; a task that is not due
// yet gets a "Coming up at ..." heading and an outlined "Done early" button; a task whose window closed unconfirmed is drawn dimmed,
// with the empty circle), plus the offline mark the caregiver home also uses. The home
// display has its own parts in src/display. Calm, high contrast, no motion.
//
// Last modified: 2026-11-14

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import {
  displayTime,
  eventDetails,
  eventKey,
  isDone,
  isDue,
  isMissed,
  SPOKEN,
  whenText,
} from '../day/format';
import type { AgendaItem, DayTask, DayViewData, EventOccurrence } from '../day/types';
import { colors, ROUNDED_FONT } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

/**
 * purpose: "Monday evening" in large type with the date below.
 * @param props: ({ day: DayViewData }) The day.
 * @return: (JSX.Element) The header.
 */
export function OrientationHeader({ day }: { day: DayViewData }) {
  return (
    <View accessible style={{ gap: 4, alignSelf: 'stretch' }}>
      <Text style={[styles.rounded, { fontSize: 40, fontWeight: '700' }]}>{day.header}</Text>
      <Text
        style={[styles.rounded, { fontSize: 24, fontWeight: '500', color: colors.secondaryText }]}
      >
        {day.dateLabel}
      </Text>
    </View>
  );
}

/**
 * purpose: A small uppercase heading for a section of the day clock.
 * @param props: ({ text: string }) The heading.
 * @return: (JSX.Element) The heading.
 */
function SectionTitle({ text }: { text: string }) {
  return (
    <Text
      accessibilityRole="header"
      style={{
        fontSize: 16,
        fontWeight: '600',
        color: colors.secondaryText,
        textTransform: 'uppercase',
      }}
    >
      {text}
    </Text>
  );
}

/**
 * purpose: The next event and who or where it involves.
 * @param props: ({ event: EventOccurrence, today: string }) The event and the day view's
 *        localDate (for the when text).
 * @return: (JSX.Element) The card.
 */
export function NextUpCard({ event, today }: { event: EventOccurrence; today: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      style={{
        gap: 6,
        padding: 18,
        borderRadius: 18,
        alignSelf: 'stretch',
        backgroundColor: `${theme.accentColor}2E`,
      }}
    >
      <SectionTitle text="Next up" />
      <Text
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        style={[styles.rounded, { fontSize: 30, fontWeight: '700' }]}
      >
        {event.label}
      </Text>
      <Text style={[styles.rounded, { fontSize: 22, fontWeight: '500' }]}>
        {eventDetails(event, whenText(event, today))}
      </Text>
    </View>
  );
}

/**
 * purpose: One agenda line: icon, time and text. A finished task is checked off and struck
 *          through; the due one is highlighted; a missed one keeps the empty circle with its
 *          label in the dimmed time color (no strike, no highlight) and is spoken as "Earlier
 *          today, not marked done".
 * @param props: (AgendaRowData) icon (SF Symbol name), time, text, done, missed and highlighted.
 * @return: (JSX.Element) The row.
 */
function AgendaRow({ icon, time, text, done, missed, highlighted }: AgendaRowData) {
  const theme = useTheme();
  const label = `${time}, ${text}`;
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityValue={{ text: rowValue(done, missed, highlighted) }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 6,
        paddingHorizontal: highlighted ? 10 : 0,
        borderRadius: 10,
        backgroundColor: highlighted ? `${theme.accentColor}40` : 'transparent',
      }}
    >
      <SymbolView name={icon} size={22} tintColor={done ? colors.success : colors.secondaryText} />
      <Text
        style={[
          styles.rounded,
          {
            fontSize: 22,
            minWidth: 96,
            color: colors.secondaryText,
            fontVariant: ['tabular-nums'],
          },
        ]}
      >
        {time}
      </Text>
      <Text
        style={[
          styles.rounded,
          {
            flex: 1,
            fontSize: 22,
            fontWeight: highlighted ? '700' : '400',
            color: missed ? colors.secondaryText : colors.text,
            textDecorationLine: done ? 'line-through' : 'none',
          },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

/** What one agenda row shows. */
interface AgendaRowData {
  icon: 'checkmark.circle.fill' | 'circle' | 'calendar';
  time: string;
  text: string;
  done: boolean;
  missed: boolean;
  highlighted: boolean;
}

/**
 * purpose: The screen reader state of an agenda row.
 * @param done: (boolean) The task is confirmed.
 * @param missed: (boolean) The task's window closed unconfirmed.
 * @param highlighted: (boolean) The task is due now.
 * @return: (string) "Done", "Due now", the neutral missed wording, or an empty string.
 */
function rowValue(done: boolean, missed: boolean, highlighted: boolean): string {
  if (done) return SPOKEN.done;
  if (highlighted) return SPOKEN.dueNow;
  return missed ? SPOKEN.missed : '';
}

/**
 * purpose: Reduce an agenda line to what its row shows: tasks are checked off when done,
 *          highlighted when due and dimmed when missed; events (nothing to confirm) carry a
 *          calendar icon.
 * @param item: (AgendaItem) The task or event line.
 * @return: (AgendaRowData) The row's icon, time, text and state.
 */
function toRow(item: AgendaItem): AgendaRowData {
  if (item.kind === 'event') {
    return {
      icon: 'calendar',
      time: displayTime(item.event.startTime),
      text: item.event.label,
      done: false,
      missed: false,
      highlighted: false,
    };
  }
  const done = isDone(item.task);
  return {
    icon: done ? 'checkmark.circle.fill' : 'circle',
    time: displayTime(item.task.scheduledTime),
    text: item.task.displayLabel,
    done,
    missed: isMissed(item.task),
    highlighted: isDue(item.task),
  };
}

/**
 * purpose: Today's tasks and events in time order; finished tasks are checked off, the due
 *          one is highlighted, a missed one is dimmed with its empty circle, and events
 *          (nothing to confirm) carry a calendar icon.
 * @param props: ({ items: AgendaItem[] }) The agenda.
 * @return: (JSX.Element) The list.
 */
export function AgendaList({ items }: { items: AgendaItem[] }) {
  return (
    <View style={{ gap: 10, alignSelf: 'stretch' }}>
      <SectionTitle text="Today" />
      {items.length === 0 && (
        <Text style={[styles.rounded, { fontSize: 22, color: colors.secondaryText }]}>
          Nothing else today.
        </Text>
      )}
      {items.map((item) => (
        <AgendaRow key={item.id} {...toRow(item)} />
      ))}
    </View>
  );
}

/**
 * purpose: The coming week's events; renders nothing when there are none. The label and
 *          the when text sit side by side and wrap onto two lines when too narrow.
 * @param props: ({ events: EventOccurrence[], today: string }) The events and the day
 *        view's localDate.
 * @return: (JSX.Element | null) The list.
 */
export function UpcomingList({ events, today }: { events: EventOccurrence[]; today: string }) {
  if (events.length === 0) return null;
  const textStyle = [styles.rounded, { fontSize: 20 }];
  return (
    <View style={{ gap: 8, alignSelf: 'stretch' }}>
      <SectionTitle text="Coming up" />
      {events.map((event) => (
        <View
          key={eventKey(event)}
          accessible
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            columnGap: 12,
            rowGap: 2,
          }}
        >
          <Text style={[textStyle, { fontWeight: '500' }]}>{event.label}</Text>
          <Text style={[textStyle, { color: colors.secondaryText }]}>{whenText(event, today)}</Text>
        </View>
      ))}
    </View>
  );
}

/** Height (points) of the Done button; much larger than the 44pt minimum. */
const DONE_BUTTON_HEIGHT = 96;

/** Background of the Done button while pressed; darker, so the white label keeps its contrast. */
const DONE_PRESSED_COLOR = '#14582A';

/** Background of the early Done button while pressed (a light tint of the success green). */
const DONE_EARLY_PRESSED_COLOR = '#D9EBDD';

/** Height (points) of the Undo button: a large target, smaller than Done. */
const UNDO_BUTTON_HEIGHT = 64;

/** The Undo line of the Done card: the task whose latest press may be taken back. */
export interface UndoOffer {
  /** The task's label. */
  label: string;
  /** The line: "<label> done.", with the offline note when the press was made offline. */
  text: string;
  /** Called when Undo is tapped. */
  onPress: () => void;
}

/**
 * purpose: The Undo line under the Done area, the one line confirming a press: its text
 *          ("<label> done.", plus the offline note) and an outlined secondary Undo button (not
 *          the filled Done style), at least 60 points high, labelled "Undo <label> done".
 * @param props: ({ undo: UndoOffer }) The task's label, the line and the tap handler.
 * @return: (JSX.Element) The line.
 */
export function UndoLine({ undo }: { undo: UndoOffer }) {
  return (
    <View style={styles.undoLine}>
      <Text style={[styles.rounded, styles.undoLabel]}>{undo.text}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Undo ${undo.label} done`}
        onPress={undo.onPress}
        style={({ pressed }) => [styles.undoButton, pressed && { backgroundColor: colors.card }]}
      >
        <Text style={[styles.rounded, styles.undoText]}>Undo</Text>
      </Pressable>
    </View>
  );
}

/**
 * purpose: The Done card: the task's label above one large Done button, the result of the last
 *          press below, and under that the Undo line of the latest press while it may be taken
 *          back (it never replaces a Done button for another task). A task that is not due yet
 *          (confirmed early) looks different on purpose: a heading "Coming up at 9:00 AM" above
 *          the label and an outlined button reading "Done early", so it is plain that this is
 *          not the task due now. With no task it shows only the result line and the Undo line,
 *          or nothing at all (never a button that does nothing).
 * @param props: ({ task, message, onPress, undo }) The task Done confirms (null when there is
 *        none), the result line (null for none), the press handler and the Undo offer (null or
 *        absent for none; the phone only).
 * @return: (JSX.Element | null) The card.
 */
export function DoneCard({
  task,
  message,
  onPress,
  undo = null,
}: {
  task: DayTask | null;
  message: string | null;
  onPress: () => void;
  undo?: UndoOffer | null;
}) {
  if (task === null && message === null && undo === null) return null;
  const early = task !== null && task.state === 'upcoming';
  const comingUp = task === null ? '' : `Coming up at ${displayTime(task.scheduledTime)}`;
  return (
    <View style={{ gap: 12, alignSelf: 'stretch' }}>
      {task !== null && (
        <>
          <View style={{ gap: 4 }}>
            {early && (
              <Text
                style={[
                  styles.rounded,
                  { fontSize: 24, fontWeight: '600', color: colors.secondaryText },
                ]}
              >
                {comingUp}
              </Text>
            )}
            <Text style={[styles.rounded, { fontSize: 30, fontWeight: '700' }]}>
              {task.displayLabel}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              early
                ? `Done early: ${task.displayLabel}, ${comingUp.toLowerCase()}`
                : `Done: ${task.displayLabel}`
            }
            onPress={onPress}
            style={({ pressed }) => [
              styles.doneButton,
              early && styles.earlyButton,
              pressed && { backgroundColor: early ? DONE_EARLY_PRESSED_COLOR : DONE_PRESSED_COLOR },
            ]}
          >
            <Text style={[styles.doneText, early && styles.earlyText]}>
              {early ? 'Done early' : 'Done'}
            </Text>
          </Pressable>
        </>
      )}
      {message !== null && (
        <Text style={[styles.rounded, { fontSize: 22, fontWeight: '500' }]}>{message}</Text>
      )}
      {undo !== null && <UndoLine undo={undo} />}
    </View>
  );
}

/**
 * purpose: A small mark shown when the latest refresh failed and the screen shows cached data.
 * @return: (JSX.Element) The mark.
 */
export function OfflineMark() {
  return (
    <View accessible accessibilityLabel="Not connected" style={styles.offline}>
      <SymbolView name="wifi.slash" size={14} tintColor={colors.secondaryText} />
      <Text style={{ fontSize: 13, color: colors.secondaryText }}>Not connected</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rounded: { fontFamily: ROUNDED_FONT, color: colors.text },
  doneButton: {
    minHeight: DONE_BUTTON_HEIGHT,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: colors.success,
  },
  earlyButton: { backgroundColor: colors.surface, borderWidth: 4, borderColor: colors.success },
  earlyText: { color: colors.success, fontSize: 34 },
  doneText: { fontFamily: ROUNDED_FONT, fontSize: 40, fontWeight: '700', color: colors.surface },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  undoLine: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 12 },
  undoLabel: { flex: 1, fontSize: 24, fontWeight: '600' },
  undoButton: {
    minHeight: UNDO_BUTTON_HEIGHT,
    minWidth: 120,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: 3,
    borderColor: colors.secondaryText,
    backgroundColor: colors.surface,
  },
  undoText: { fontSize: 28, fontWeight: '700' },
});
