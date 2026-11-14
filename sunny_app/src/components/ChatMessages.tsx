// sunny_app/src/components/ChatMessages.tsx
//
// Purpose: The two message shapes shared by the voice transcript and the caregiver Chat tab:
// the user's words as a right-aligned bubble tinted with the accent color, and Sunny's words as
// left-aligned plain text. Text is black at the theme body font size unless the caller passes
// its own text style. VoiceOver reads "You said: ..." and "Sunny said: ...". A user bubble may
// carry a speaker (another caregiver in the shared chat): their name shows in a small caption
// above the bubble and VoiceOver reads "<name> said: ...". Sunny's message may carry a small
// plain label above it (a post such as "Daily summary, Friday, November 13"), which VoiceOver
// reads first.
//
// Last modified: 2026-11-14

import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';

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

/** Props of UserBubble. */
interface UserBubbleProps extends MessageProps {
  /** Someone other than "you" who said this; shown above the bubble and read by VoiceOver. */
  speaker?: string | null;
}

/**
 * purpose: Render the user's message as a right-aligned accent-tinted bubble.
 * @param props: (UserBubbleProps) The text, optional text style, the free space at the left
 *        and, for another caregiver's message, the speaker's name.
 * @return: (JSX.Element) The bubble row.
 */
export function UserBubble({ text, textStyle, inset = 16, speaker = null }: UserBubbleProps) {
  const { accentColor, bodyFontSize, cornerRadius } = useTheme();
  return (
    <View
      style={[styles.userRow, { paddingLeft: inset }]}
      accessible
      accessibilityLabel={`${speaker ?? 'You'} said: ${text}`}
    >
      {speaker !== null && <Text style={[type.caption, styles.speaker]}>{speaker}</Text>}
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

/** Props of AgentMessage. */
interface AgentMessageProps extends MessageProps {
  /** A small plain label above the text (for example "Daily summary" and the date). */
  label?: string | null;
}

/**
 * purpose: Render Sunny's message as left-aligned plain text, with an optional small label
 *          above it.
 * @param props: (AgentMessageProps) The text, optional text style, the free space at the right
 *        and the optional label.
 * @return: (JSX.Element) The message row.
 */
export function AgentMessage({ text, textStyle, inset = 16, label = null }: AgentMessageProps) {
  const { bodyFontSize } = useTheme();
  return (
    <View
      style={[label === null ? styles.agentRow : styles.labelledRow, { paddingRight: inset }]}
      accessible
      accessibilityLabel={label === null ? `Sunny said: ${text}` : `${label}. Sunny said: ${text}`}
    >
      {label !== null && <Text style={[type.caption, styles.label]}>{label}</Text>}
      <Text style={[styles.text, styles.agentText, { fontSize: bodyFontSize }, textStyle]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end' },
  speaker: { color: colors.secondaryText, paddingBottom: 2, paddingRight: 4 },
  agentRow: { flexDirection: 'row', justifyContent: 'flex-start' },
  labelledRow: { alignItems: 'flex-start' },
  label: { color: colors.secondaryText, paddingTop: 4 },
  bubble: { paddingHorizontal: 16, paddingVertical: 8 },
  agentText: { paddingVertical: 8 },
  text: { color: colors.ink },
});
