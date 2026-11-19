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
import { useSinglePress } from './useSinglePress';

interface PrimaryButtonProps {
  label: string;
  onPress: () => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  compact?: boolean;
  variant?: 'solid' | 'outline';
  tone?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

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
  const { pressing, press } = useSinglePress(onPress, externalBusy || disabled);
  const busy = externalBusy || pressing;

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
      onPress={() => void press()}
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
