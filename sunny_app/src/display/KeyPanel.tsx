// sunny_app/src/display/KeyPanel.tsx
//
// Purpose: The on-screen stand-ins for the home display's hardware Done and Talk keys, used
// while the display runs on an iPad. They sit on the dark device body apart from the paper
// panel's content, and never move or hide while the iPad is held still, the way physical keys
// would not. With the iPad in landscape they form a column to the right of the panel, as tall
// as it (Done on top, Talk on the bottom); in portrait they form a row below it, as wide as it
// (Done on the left, Talk on the right). A status line between the keys shows the last key's
// result or voice message, "Press Talk to stop" during a voice session, or "Not connected"
// when the backend is unreachable. Each key
// shows the same symbol and word as the keycaps drawn in the prompts, looks raised, visibly
// sinks while pressed. Done dims while its confirm is in flight; Talk never dims, since it
// can always start or stop a session.
//
// Last modified: 2026-11-09

import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { DText } from './DisplayParts';
import { font, ink } from './theme';

/** Where the keys sit relative to the paper panel. */
export type KeyPlacement = 'right' | 'below';

/** Width (points) of the column of keys to the right of the panel, and the widest a key gets. */
export const KEY_WIDTH = 260;

/** Height (points) of the row of keys below the panel. */
export const KEY_ROW_HEIGHT = 160;

/** The status line between the keys wraps to at most this many lines. */
const STATUS_LINES = 4;

/**
 * purpose: One raised key: a symbol above its word.
 * @param props: ({ icon, label, hint, busy, onPress }) The key's symbol and word, its
 *        VoiceOver hint, whether its action is in progress, and the press handler.
 * @return: (JSX.Element) The key.
 */
function Key({
  icon,
  label,
  hint,
  busy,
  onPress,
}: {
  icon: SFSymbol;
  label: string;
  hint: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ busy }}
      onPress={onPress}
      style={({ pressed }) => [styles.key, pressed && styles.keyPressed, busy && styles.keyBusy]}
    >
      <SymbolView name={icon} size={56} weight="bold" tintColor={ink.ink} />
      <DText style={font.key}>{label}</DText>
    </Pressable>
  );
}

/**
 * purpose: The Done and Talk keys with the status line between them, as a column beside the
 *          paper panel or a row below it.
 * @param props: ({ placement, length, status, doneBusy, onDone, onTalk }) Where the
 *        keys sit; the length of the panel side they run along (its height for 'right', its
 *        width for 'below', so the keys line up with the panel's edges); the status line; whether
 *        Done is busy; and press handlers.
 * @return: (JSX.Element) The keys.
 */
export function KeyPanel({
  placement,
  length,
  status,
  doneBusy,
  onDone,
  onTalk,
}: {
  placement: KeyPlacement;
  length: number;
  status: string | null;
  doneBusy: boolean;
  onDone: () => void;
  onTalk: () => void;
}) {
  const right = placement === 'right';
  return (
    <View style={right ? [styles.column, { height: length }] : [styles.row, { width: length }]}>
      <Key
        icon="checkmark"
        label="Done"
        hint="Marks the task on the screen as done"
        busy={doneBusy}
        onPress={onDone}
      />
      <View style={[styles.statusBox, right ? styles.statusInColumn : styles.statusInRow]}>
        <DText numberOfLines={STATUS_LINES} style={[font.keyStatus, styles.status]}>
          {status}
        </DText>
      </View>
      <Key
        icon="mic"
        label="Talk"
        hint="Talk to Sunny. Press again to stop."
        busy={false}
        onPress={onTalk}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  column: { width: KEY_WIDTH, gap: 16 },
  row: { height: KEY_ROW_HEIGHT, flexDirection: 'row', gap: 24 },
  // Keys share the column's height, or the row's width with the status line, up to KEY_WIDTH.
  key: {
    flex: 1,
    maxWidth: KEY_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderRadius: 24,
    backgroundColor: ink.paper,
    borderBottomWidth: 8,
    borderBottomColor: ink.keyEdge,
  },
  keyPressed: {
    backgroundColor: ink.keyPressed,
    borderBottomWidth: 2,
    transform: [{ translateY: 6 }],
  },
  keyBusy: { opacity: 0.5 },
  statusBox: { justifyContent: 'center' },
  // Fixed at the full STATUS_LINES so a new status line never moves the keys.
  statusInColumn: { height: STATUS_LINES * font.keyStatus.lineHeight },
  statusInRow: { flex: 1 },
  status: { textAlign: 'center', color: ink.paper },
});
