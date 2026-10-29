// sunny_app/src/components/DayComponents.tsx
//
// Purpose: The building blocks of the day clock, shared by the phone's Today screen and
// the home display: the orientation header ("Monday evening", date below, no minute
// clock), the Next up card, today's agenda and the coming week. Sizes scale with a
// `scale` prop so the display can use much larger type than the phone. Calm, high
// contrast, no motion.
//
// Last modified: 2026-10-28

import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { displayTime, eventKey, isDone, isDue, whenText } from '../day/format';
import type { AgendaItem, DayViewData, EventOccurrence } from '../day/types';
import { colors, ROUNDED_FONT } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

/** Props shared by every day component: a size multiplier (1 on the phone). */
interface ScaleProps {
  scale?: number;
}

/**
 * purpose: "Monday evening" in large type with the date below.
 * @param props: ({ day: DayViewData, scale?: number }) The day and the size multiplier.
 * @return: (JSX.Element) The header.
 */
export function OrientationHeader({ day, scale = 1 }: ScaleProps & { day: DayViewData }) {
  return (
    <View accessible style={{ gap: 4 * scale, alignSelf: 'stretch' }}>
      <Text style={[styles.rounded, { fontSize: 40 * scale, fontWeight: '700' }]}>
        {day.header}
      </Text>
      <Text
        style={[
          styles.rounded,
          { fontSize: 24 * scale, fontWeight: '500', color: colors.secondaryText },
        ]}
      >
        {day.date_label}
      </Text>
    </View>
  );
}

/**
 * purpose: A small uppercase heading for a section of the day clock.
 * @param props: ({ text: string, scale?: number }) The heading and the size multiplier.
 * @return: (JSX.Element) The heading.
 */
function SectionTitle({ text, scale = 1 }: ScaleProps & { text: string }) {
  return (
    <Text
      accessibilityRole="header"
      style={{
        fontSize: 16 * scale,
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
 * purpose: Describe an event as "<when> with <visitor> at <place>".
 * @param event: (EventOccurrence) The event.
 * @param when: (string) Already-formatted when text.
 * @return: (string) The details line.
 */
function eventDetails(event: EventOccurrence, when: string): string {
  const parts = [when];
  if (event.visitor_name) parts.push(`with ${event.visitor_name}`);
  if (event.place) parts.push(`at ${event.place}`);
  return parts.join(' ');
}

/**
 * purpose: The next event and who or where it involves.
 * @param props: ({ event: EventOccurrence, today: string, scale?: number }) The event, the
 *        day view's local_date (for the when text), and the size multiplier.
 * @return: (JSX.Element) The card.
 */
export function NextUpCard({
  event,
  today,
  scale = 1,
}: ScaleProps & { event: EventOccurrence; today: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      style={{
        gap: 6 * scale,
        padding: 18 * scale,
        borderRadius: 18 * scale,
        alignSelf: 'stretch',
        backgroundColor: `${theme.accentColor}2E`,
      }}
    >
      <SectionTitle text="Next up" scale={scale} />
      <Text
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        style={[styles.rounded, { fontSize: 30 * scale, fontWeight: '700' }]}
      >
        {event.label}
      </Text>
      <Text style={[styles.rounded, { fontSize: 22 * scale, fontWeight: '500' }]}>
        {eventDetails(event, whenText(event, today))}
      </Text>
    </View>
  );
}

/**
 * purpose: One agenda line: icon, time and text. A finished task is checked off and struck
 *          through; the due one is highlighted.
 * @param props: (AgendaRowData & { scale: number }) icon (SF Symbol name), time, text, done,
 *        highlighted and the size multiplier.
 * @return: (JSX.Element) The row.
 */
function AgendaRow({
  icon,
  time,
  text,
  done,
  highlighted,
  scale,
}: Required<ScaleProps> & AgendaRowData) {
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
        gap: 12 * scale,
        paddingVertical: 6 * scale,
        paddingHorizontal: highlighted ? 10 * scale : 0,
        borderRadius: 10 * scale,
        backgroundColor: highlighted ? `${theme.accentColor}40` : 'transparent',
      }}
    >
      <SymbolView
        name={icon}
        size={22 * scale}
        tintColor={done ? colors.success : colors.secondaryText}
      />
      <Text
        style={[
          styles.rounded,
          {
            fontSize: 22 * scale,
            minWidth: 96 * scale,
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
            fontSize: 22 * scale,
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
      time: displayTime(item.event.start_time),
      text: item.event.label,
      done: false,
      highlighted: false,
    };
  }
  const done = isDone(item.task);
  return {
    icon: done ? 'checkmark.circle.fill' : 'circle',
    time: displayTime(item.task.scheduled_time),
    text: item.task.display_label,
    done,
    highlighted: isDue(item.task),
  };
}

/**
 * purpose: Today's tasks and events in time order; finished tasks are checked off, the due
 *          one is highlighted, and events (nothing to confirm) carry a calendar icon.
 * @param props: ({ items: AgendaItem[], scale?: number }) The agenda and the size multiplier.
 * @return: (JSX.Element) The list.
 */
export function AgendaList({ items, scale = 1 }: ScaleProps & { items: AgendaItem[] }) {
  return (
    <View style={{ gap: 10 * scale, alignSelf: 'stretch' }}>
      <SectionTitle text="Today" scale={scale} />
      {items.length === 0 && (
        <Text style={[styles.rounded, { fontSize: 22 * scale, color: colors.secondaryText }]}>
          Nothing else today.
        </Text>
      )}
      {items.map((item) => (
        <AgendaRow key={item.id} {...toRow(item)} scale={scale} />
      ))}
    </View>
  );
}

/**
 * purpose: The coming week's events; renders nothing when there are none. The label and
 *          the when text sit side by side and wrap onto two lines when too narrow.
 * @param props: ({ events: EventOccurrence[], today: string, scale?: number }) The events,
 *        the day view's local_date, and the size multiplier.
 * @return: (JSX.Element | null) The list.
 */
export function UpcomingList({
  events,
  today,
  scale = 1,
}: ScaleProps & { events: EventOccurrence[]; today: string }) {
  if (events.length === 0) return null;
  const textStyle = [styles.rounded, { fontSize: 20 * scale }];
  return (
    <View style={{ gap: 8 * scale, alignSelf: 'stretch' }}>
      <SectionTitle text="Coming up" scale={scale} />
      {events.map((event) => (
        <View
          key={eventKey(event)}
          accessible
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            columnGap: 12 * scale,
            rowGap: 2 * scale,
          }}
        >
          <Text style={[textStyle, { fontWeight: '500' }]}>{event.label}</Text>
          <Text style={[textStyle, { color: colors.secondaryText }]}>{whenText(event, today)}</Text>
        </View>
      ))}
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
  offline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
