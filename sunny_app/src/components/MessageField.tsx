// sunny_app/src/components/MessageField.tsx
//
// Purpose: The presentational message field shared by the voice chat input and the caregiver
// Chat tab: a rounded card holding a text input and a round accent send button with an up
// arrow. It owns no state; the caller holds the text and decides what sending does. The send
// button (and the return key) do nothing while the text is blank or the caller passes
// disabled, and the button is dimmed.
//
// Last modified: 2026-10-31

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

/** Props for MessageField. */
interface MessageFieldProps {
  value: string;
  onChangeText: (text: string) => void;
  /** Called when the send button or the return key is pressed and sending is allowed. */
  onSend: () => void;
  /** True to block sending (for example while a send is in flight); blank text always blocks. */
  disabled?: boolean;
  placeholder: string;
  /** Overrides for the input's text (for example a different font); defaults to the theme size. */
  inputStyle?: StyleProp<TextStyle>;
}

/**
 * purpose: Render the message input row with its send button.
 * @param props: (MessageFieldProps) The text and its change handler, the send handler, whether
 *        sending is blocked, the placeholder (also the accessibility label) and optional input
 *        text style.
 * @return: (JSX.Element) The input row.
 */
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

  /**
   * purpose: Send unless sending is blocked.
   * @return: (void)
   */
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
