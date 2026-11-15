import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';

const USER_BUBBLE_TINT = '1F';

interface MessageProps {
  text: string;
  textStyle?: StyleProp<TextStyle>;
  inset?: number;
}

interface UserBubbleProps extends MessageProps {
  speaker?: string | null;
}

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

interface AgentMessageProps extends MessageProps {
  label?: string | null;
}

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
