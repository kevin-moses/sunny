import { SymbolView } from 'expo-symbols';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

interface MessageFieldProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder: string;
  inputStyle?: StyleProp<TextStyle>;
}

export function MessageField({
  value,
  onChangeText,
  onSend,
  disabled = false,
  placeholder,
  inputStyle,
}: MessageFieldProps) {
  const { accentColor, bodyFontSize } = useTheme();
  const blocked = disabled || value.trim() === '';

  const send = (): void => {
    if (!blocked) onSend();
  };

  return (
    <View style={styles.row}>
      <TextInput
        style={[styles.input, { fontSize: bodyFontSize }, inputStyle]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.secondaryText}
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={send}
        accessibilityLabel={placeholder}
      />
      <Pressable
        onPress={send}
        disabled={blocked}
        accessibilityRole="button"
        accessibilityLabel="Send message"
        style={[styles.send, { backgroundColor: accentColor, opacity: blocked ? 0.4 : 1 }]}
      >
        <SymbolView name="arrow.up" size={24} tintColor={colors.onAccent} weight="semibold" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingLeft: 16,
    paddingRight: 12,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: colors.card,
  },
  input: { flex: 1, color: colors.text, paddingVertical: 0 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
