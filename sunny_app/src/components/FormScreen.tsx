import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, GRID, ROUNDED_FONT } from '../theme/colors';

interface FormScreenProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export const formStyles = StyleSheet.create({
  title: {
    fontFamily: ROUNDED_FONT,
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    color: colors.text,
  },
  subtitle: {
    fontFamily: ROUNDED_FONT,
    fontSize: 20,
    textAlign: 'center',
    color: colors.secondaryText,
  },
  input: {
    alignSelf: 'stretch',
    maxWidth: 420,
    width: '100%',
    padding: 4 * GRID,
    fontFamily: ROUNDED_FONT,
    fontSize: 24,
    color: colors.text,
    backgroundColor: colors.overlayMedium,
  },
  codeInput: { fontFamily: 'Menlo', fontSize: 34, fontWeight: '600', textAlign: 'center' },
  error: { fontSize: 18, textAlign: 'center', color: colors.seriousForeground },
  button: { maxWidth: 420, width: '100%' },
});

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6 * GRID,
    paddingHorizontal: 8 * GRID,
  },
});

export function FormScreen({ title, subtitle, children }: FormScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 8 * GRID, paddingBottom: insets.bottom + 8 * GRID },
        ]}
      >
        <Text accessibilityRole="header" style={formStyles.title}>
          {title}
        </Text>
        {subtitle !== undefined && <Text style={formStyles.subtitle}>{subtitle}</Text>}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
