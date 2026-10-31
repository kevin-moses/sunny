// sunny_app/src/components/ChatMessages.tsx
//
// Purpose: The two message shapes shared by the voice transcript and the caregiver Chat tab:
// the user's words as a right-aligned bubble tinted with the accent color, and Sunny's words as
// left-aligned plain text. Text is black at the theme body font size unless the caller passes
// its own text style. VoiceOver reads "You said: ..." and "Sunny said: ...".
//
// Last modified: 2026-10-31

import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

/** Opacity of the accent tint behind the user's bubbles. */
const USER_BUBBLE_TINT = '1F';

/** Props shared by both message shapes. */
interface MessageProps {
  text: string;
  /** Overrides for the message text (for example a different font); defaults to the theme size. */
  textStyle?: StyleProp<TextStyle>;
  /** Space (points) kept free on the side away from the speaker; defaults to 16. */
  inset?: number;
}

/**
 * purpose: Render the user's message as a right-aligned accent-tinted bubble.
 * @param props: (MessageProps) The text, optional text style and the free space at the left.
 * @return: (JSX.Element) The bubble row.
 */
export function UserBubble({ text, textStyle, inset = 16 }: MessageProps) {
  const { accentColor, bodyFontSize, cornerRadius } = useTheme();
  return (
    <View
      style={[styles.userRow, { paddingLeft: inset }]}
      accessible
      accessibilityLabel={`You said: ${text}`}
    >
      <View
        style={[
          styles.bubble,
          { borderRadius: cornerRadius, backgroundColor: `${accentColor}${USER_BUBBLE_TINT}` },
        ]}
      >
        <Text style={[styles.text, { fontSize: bodyFontSize }, textStyle]}>{text}</Text>
      </View>
    </View>
  );
}

/**
 * purpose: Render Sunny's message as left-aligned plain text.
 * @param props: (MessageProps) The text, optional text style and the free space at the right.
 * @return: (JSX.Element) The message row.
 */
export function AgentMessage({ text, textStyle, inset = 16 }: MessageProps) {
  const { bodyFontSize } = useTheme();
  return (
    <View
      style={[styles.agentRow, { paddingRight: inset }]}
      accessible
      accessibilityLabel={`Sunny said: ${text}`}
    >
      <Text style={[styles.text, styles.agentText, { fontSize: bodyFontSize }, textStyle]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  agentRow: { flexDirection: 'row', justifyContent: 'flex-start' },
  bubble: { paddingHorizontal: 16, paddingVertical: 8 },
  agentText: { paddingVertical: 8 },
  text: { color: colors.ink },
});
