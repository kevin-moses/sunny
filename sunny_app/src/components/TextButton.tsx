// sunny_app/src/components/TextButton.tsx
//
// Purpose: A plain text button for secondary actions (Back, Sign out, Resend code, Use a
// different email). At least 44pt tall for easy tapping; dimmed while disabled.
//
// Last modified: 2026-10-30

import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, ROUNDED_FONT } from '../theme/colors';

/** Props for TextButton. */
interface TextButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * purpose: Render a text-only button.
 * @param props: (TextButtonProps) Label, press handler, disabled flag, accessibility hint and
 *        optional extra style.
 * @return: (JSX.Element) The button.
 */
export function TextButton({
  label,
  onPress,
  disabled = false,
  accessibilityHint,
  style,
}: TextButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled, style]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  disabled: { opacity: 0.4 },
  label: {
    fontFamily: ROUNDED_FONT,
    fontSize: 20,
    fontWeight: '600',
    color: colors.secondaryText,
  },
});
