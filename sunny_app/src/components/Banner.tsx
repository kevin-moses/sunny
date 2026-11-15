import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { GRID, statusTones } from '../theme/colors';

interface BannerProps {
  tone: keyof typeof statusTones;
  title: string;
  message: string;
  onDismiss?: () => void;
}

export function Banner({ tone, title, message, onDismiss }: BannerProps) {
  const { foreground, background, separator } = statusTones[tone];
  return (
    <View
      accessibilityRole="alert"
      style={[styles.banner, { backgroundColor: background, borderColor: separator }]}
    >
      <View style={styles.titleRow}>
        <SymbolView name="exclamationmark.triangle" size={16} tintColor={foreground} />
        <Text style={[styles.text, styles.title, { color: foreground }]}>{title}</Text>
        {onDismiss !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Dismiss ${title.toLowerCase()}`}
            hitSlop={12}
            onPress={onDismiss}
          >
            <SymbolView name="xmark" size={16} tintColor={foreground} />
          </Pressable>
        )}
      </View>
      <Text style={[styles.text, { color: foreground }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    gap: 2 * GRID,
    padding: 3 * GRID,
    marginHorizontal: 4 * GRID,
    borderRadius: 2 * GRID,
    borderWidth: 1,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 2 * GRID },
  title: { flex: 1, fontWeight: '600' },
  text: { fontSize: 15 },
});
