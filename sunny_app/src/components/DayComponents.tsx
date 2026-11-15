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

interface AgendaRowData {
  icon: 'checkmark.circle.fill' | 'circle' | 'calendar';
  time: string;
  text: string;
  done: boolean;
  missed: boolean;
  highlighted: boolean;
}

function rowValue(done: boolean, missed: boolean, highlighted: boolean): string {
  if (done) return SPOKEN.done;
  if (highlighted) return SPOKEN.dueNow;
  return missed ? SPOKEN.missed : '';
}

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

const DONE_BUTTON_HEIGHT = 96;

const DONE_PRESSED_COLOR = '#14582A';

const DONE_EARLY_PRESSED_COLOR = '#D9EBDD';

const UNDO_BUTTON_HEIGHT = 64;

export interface UndoOffer {
  label: string;
  text: string;
  onPress: () => void;
}

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
