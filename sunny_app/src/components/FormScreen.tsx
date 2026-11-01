// sunny_app/src/components/FormScreen.tsx
//
// Purpose: The shared scaffold of the full-screen forms (welcome, join-code pairing, caregiver
// sign-in and onboarding): a keyboard-avoiding scroll view padded by the safe-area insets, a
// centered content column with a header title and an optional subtitle, then the screen's own
// children. formStyles holds the text, input and button styles those screens share, so they
// cannot drift apart.
//
// Last modified: 2026-10-31

import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, GRID, ROUNDED_FONT } from '../theme/colors';

/** Props for FormScreen. */
interface FormScreenProps {
  /** The header shown at the top of the column. */
  title: string;
  /** A line of explanation under the title; omitted when absent. */
  subtitle?: string;
  /** The rest of the form. */
  children: ReactNode;
}

/** Styles shared by the form screens; the screens apply these to their own fields and buttons. */
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

/**
 * purpose: Lay out a full-screen form: title, optional subtitle, then the children, centered
 *          and kept clear of the keyboard and the safe areas.
 * @param props: (FormScreenProps) The title, optional subtitle and children.
 * @return: (JSX.Element) The screen.
 */
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
