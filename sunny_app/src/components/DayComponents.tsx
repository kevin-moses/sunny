// sunny_app/src/components/DayComponents.tsx
//
// Purpose: The building blocks of the senior phone's day clock: the orientation header
// ("Monday evening", date below, no minute clock), the Next up card, today's agenda and the
// coming week, the Done card (the due task's label above one large Done button, with the
// result line of the last press), plus the offline mark the caregiver home also uses. The home
// display has its own parts in src/display. Calm, high contrast, no motion.
//
// Last modified: 2026-11-09

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { displayTime, eventDetails, eventKey, isDone, isDue, whenText } from '../day/format';
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
 *          through; the due one is highlighted.
 * @param props: (AgendaRowData) icon (SF Symbol name), time, text, done and highlighted.
 * @return: (JSX.Element) The row.
 */
function AgendaRow({ icon, time, text, done, highlighted }: AgendaRowData) {
  const theme = useTheme();
  const label = `${time}, ${text}`;
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityValue={{ text: done ? 'Done' : highlighted ? 'Due now' : '' }}
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
  highlighted: boolean;
}

/**
 * purpose: Reduce an agenda line to what its row shows: tasks are checked off when done and
 *          highlighted when due; events (nothing to confirm) carry a calendar icon.
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
      highlighted: false,
    };
  }
  const done = isDone(item.task);
  return {
    icon: done ? 'checkmark.circle.fill' : 'circle',
    time: displayTime(item.task.scheduledTime),
    text: item.task.displayLabel,
    done,
    highlighted: isDue(item.task),
  };
}

/**
 * purpose: Today's tasks and events in time order; finished tasks are checked off, the due
 *          one is highlighted, and events (nothing to confirm) carry a calendar icon.
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

/**
 * purpose: The Done card: the due task's label above one large Done button, and the result
 *          of the last press below. With nothing due it shows only the result line, or
 *          nothing at all (never a button that does nothing).
 * @param props: ({ task, busy, message, onPress }) The task Done confirms (null when nothing
 *        is due), whether a confirm is in flight, the result line (null for none) and the
 *        press handler.
 * @return: (JSX.Element | null) The card.
 */
export function DoneCard({
  task,
  busy,
  message,
  onPress,
}: {
  task: DayTask | null;
  busy: boolean;
  message: string | null;
  onPress: () => void;
}) {
  if (task === null && message === null) return null;
  return (
    <View style={{ gap: 12, alignSelf: 'stretch' }}>
      {task !== null && (
        <>
          <Text style={[styles.rounded, { fontSize: 30, fontWeight: '700' }]}>
            {task.displayLabel}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Done: ${task.displayLabel}`}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={onPress}
            style={({ pressed }) => [
              styles.doneButton,
              pressed && { backgroundColor: DONE_PRESSED_COLOR },
            ]}
          >
            {busy ? (
              <View style={styles.savingRow}>
                <ActivityIndicator size="large" color={colors.surface} />
                <Text style={styles.doneText}>Saving</Text>
              </View>
            ) : (
              <Text style={styles.doneText}>Done</Text>
            )}
          </Pressable>
        </>
      )}
      {message !== null && (
        <Text style={[styles.rounded, { fontSize: 22, fontWeight: '500' }]}>{message}</Text>
      )}
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
  savingRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  doneText: { fontFamily: ROUNDED_FONT, fontSize: 40, fontWeight: '700', color: colors.surface },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
