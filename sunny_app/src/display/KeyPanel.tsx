import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { DText } from './DisplayParts';
import { font, ink } from './theme';

export type KeyPlacement = 'right' | 'below';

export const KEY_WIDTH = 260;

export const KEY_ROW_HEIGHT = 160;

const STATUS_LINES = 4;

function Key({
  icon,
  label,
  hint,
  busy = false,
  onPress,
}: {
  icon: SFSymbol;
  label: string;
  hint: string;
  busy?: boolean;
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
      <Key icon="mic" label="Talk" hint="Talk to Sunny. Press again to stop." onPress={onTalk} />
    </View>
  );
}

const styles = StyleSheet.create({
  column: { width: KEY_WIDTH, gap: 16 },
  row: { height: KEY_ROW_HEIGHT, flexDirection: 'row', gap: 24 },
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
  statusInColumn: { height: STATUS_LINES * font.keyStatus.lineHeight },
  statusInRow: { flex: 1 },
  status: { textAlign: 'center', color: ink.paper },
});
