// sunny_app/src/screens/ConfigErrorScreen.tsx
//
// Purpose: Shown instead of the app when the Clerk publishable key is empty (an empty env
// override), so a missing configuration is a clear message for the developer rather than a
// crash. Seniors never see it in a correctly configured build.
//
// Last modified: 2026-10-29

import { StyleSheet, Text, View } from 'react-native';

import { colors, GRID, ROUNDED_FONT } from '../theme/colors';

/**
 * purpose: Explain that the Clerk publishable key is missing and how to set it.
 * @return: (JSX.Element) The screen.
 */
export function ConfigErrorScreen() {
  return (
    <View style={styles.root}>
      <Text accessibilityRole="header" style={styles.title}>
        Sunny is not configured
      </Text>
      <Text style={styles.body}>
        The Clerk publishable key is empty. Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to a valid key in
        sunny_app/.env.local (or remove the override to use the default), then restart Metro with a
        cleared cache.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2 * GRID,
    padding: 4 * GRID,
    backgroundColor: colors.card,
  },
  title: { fontFamily: ROUNDED_FONT, fontSize: 24, fontWeight: '700', color: colors.text },
  body: { fontSize: 17, textAlign: 'center', color: colors.secondaryText },
});
