import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, ROUNDED_FONT } from '../theme/colors';

interface TextButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

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
