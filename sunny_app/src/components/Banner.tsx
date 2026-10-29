// sunny_app/src/components/Banner.tsx
//
// Purpose: A snackbar shown at the top of the screen for errors and warnings. The tone
// picks the "serious" (error) or "moderate" (warning) status colors; an optional dismiss
// button is shown when onDismiss is given.
//
// Last modified: 2026-10-28

import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, GRID } from '../theme/colors';

/** Status color sets, keyed by tone. */
const TONES = {
  serious: {
    foreground: colors.seriousForeground,
    background: colors.seriousBackground,
    separator: colors.seriousSeparator,
  },
  moderate: {
    foreground: colors.moderateForeground,
    background: colors.moderateBackground,
    separator: colors.moderateSeparator,
  },
} as const;

/** Props for Banner. */
interface BannerProps {
  tone: keyof typeof TONES;
  title: string;
  message: string;
  /** When given, a dismiss button is shown and calls this. */
  onDismiss?: () => void;
}

/**
 * purpose: Show a titled message in the colors of its tone, with an optional dismiss button.
 * @param props: (BannerProps) The tone, title, message and optional dismiss handler.
 * @return: (JSX.Element) The banner.
 */
export function Banner({ tone, title, message, onDismiss }: BannerProps) {
  const { foreground, background, separator } = TONES[tone];
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
