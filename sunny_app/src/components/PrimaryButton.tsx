// sunny_app/src/components/PrimaryButton.tsx
//
// Purpose: The full-width solid accent button used for primary actions (for example
// Connect and Talk to Sunny). Its press handler may be async: while it runs, or while the
// caller passes busy, the label is replaced by a spinner (with the optional busyLabel next
// to it) and further presses are ignored. At least 60pt tall for easy tapping.
//
// Last modified: 2026-10-28

import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

/** Props for PrimaryButton. */
interface PrimaryButtonProps {
  label: string;
  /** Called on press; may be async. It should handle its own errors. */
  onPress: () => void | Promise<void>;
  disabled?: boolean;
  /** True while the caller is working on the button's behalf; shows the spinner. */
  busy?: boolean;
  /** Text shown next to the spinner while busy; the spinner is shown alone without it. */
  busyLabel?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * purpose: Render a prominent accent button with a busy spinner for async presses.
 * @param props: (PrimaryButtonProps) Label, press handler, disabled and busy flags, busy
 *        label, accessibility label and hint, and optional extra style (for example a max
 *        width).
 * @return: (JSX.Element) The button.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy: externalBusy = false,
  busyLabel,
  accessibilityLabel,
  accessibilityHint,
  style,
}: PrimaryButtonProps) {
  const theme = useTheme();
  const [pressing, setPressing] = useState(false);
  const mounted = useRef(true);
  const busy = externalBusy || pressing;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * purpose: Run the press handler once at a time, showing the spinner while it runs.
   * @return: (Promise<void>) resolves when the handler finished
   */
  const handlePress = async (): Promise<void> => {
    if (busy || disabled) return;
    setPressing(true);
    try {
      await onPress();
    } finally {
      if (mounted.current) setPressing(false);
    }
  };

  const textStyle: TextStyle = {
    fontSize: theme.buttonFontSize,
    fontWeight: '600',
    color: colors.onAccent,
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={() => void handlePress()}
      style={({ pressed }) => [
        styles.button,
        {
          borderRadius: theme.cornerRadius,
          backgroundColor: theme.accentColor,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator color={colors.onAccent} />
          {busyLabel !== undefined && <Text style={textStyle}>{busyLabel}</Text>}
        </View>
      ) : (
        <Text style={textStyle}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 60,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
});
