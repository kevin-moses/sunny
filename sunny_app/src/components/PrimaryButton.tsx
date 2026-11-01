// sunny_app/src/components/PrimaryButton.tsx
//
// Purpose: The full-width solid accent button used for primary actions (for example
// Connect and Talk to Sunny). Its press handler may be async: while it runs, or while the
// caller passes busy, the label is replaced by a spinner (with the optional busyLabel next
// to it) and further presses are ignored. At least 60pt tall for easy tapping; the compact
// variant is a small left-aligned button with 15pt bold text for inline actions in cards. The
// outline variant has a transparent background with a 1px border and text in a tone color (the
// accent by default) for a secondary action beside a solid one.
//
// Last modified: 2026-11-01

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
  /** A small inline button (smaller padding, left-aligned, 15pt bold text) instead of full width. */
  compact?: boolean;
  /** 'solid' (default) fills with the accent; 'outline' is transparent with a border and text in tone. */
  variant?: 'solid' | 'outline';
  /** Border, text and spinner color of the outline variant; defaults to the accent. */
  tone?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * purpose: Render a prominent accent button with a busy spinner for async presses.
 * @param props: (PrimaryButtonProps) Label, press handler, disabled and busy flags, busy
 *        label, compact flag, variant and outline tone, accessibility label and hint, and
 *        optional extra style (for example a max width).
 * @return: (JSX.Element) The button.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy: externalBusy = false,
  busyLabel,
  compact = false,
  variant = 'solid',
  tone,
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

  const outline = variant === 'outline';
  const foreground = outline ? (tone ?? theme.accentColor) : colors.onAccent;
  const textStyle: TextStyle = compact
    ? { fontSize: 15, fontWeight: '700', color: foreground }
    : { fontSize: theme.buttonFontSize, fontWeight: '600', color: foreground };

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
        compact && styles.compact,
        {
          borderRadius: theme.cornerRadius,
          ...(outline
            ? { backgroundColor: 'transparent', borderWidth: 1, borderColor: foreground }
            : { backgroundColor: theme.accentColor }),
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator color={foreground} />
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
  compact: { minHeight: 36, alignSelf: 'flex-start', paddingVertical: 8 },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
});
