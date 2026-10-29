// sunny_app/src/voice/ControlBar.tsx
//
// Purpose: Bottom action bar of the conversation: a microphone toggle with a small 3-bar local level meter, a text/voice mode toggle (disabled until the
// agent has joined), and a red end-call button. Every button is a 60x60 point target for
// senior accessibility, with explicit VoiceOver labels.
//
// Last modified: 2026-10-28

import { BarVisualizer } from '@livekit/react-native';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { BACKGROUND, colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { useConversation, useVoice } from './voiceContext';

/** Size of every control button, in points. */
const BUTTON_SIZE = 60;

/** Props for one round control button. */
interface ControlButtonProps {
  label: string;
  symbol: SymbolViewProps['name'];
  onPress: () => void;
  disabled?: boolean;
  toggled?: boolean;
  serious?: boolean;
  accentColor: string;
  children?: ReactElement;
}

/**
 * purpose: Render one 60x60 control button with an SF Symbol and optional extra content.
 * @param props: (ControlButtonProps) label, symbol, handler and visual state
 * @return: (ReactElement) the button
 */
function ControlButton(props: ControlButtonProps): ReactElement {
  const { label, symbol, onPress, disabled, toggled, serious, accentColor, children } = props;
  const foreground = serious ? colors.seriousForeground : colors.text;
  const background = serious ? colors.seriousBackground : toggled ? accentColor : colors.card;
  const border = serious ? colors.seriousSeparator : colors.separator;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!toggled }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={styles.content}>
        <SymbolView name={symbol} size={24} tintColor={foreground} weight="medium" />
        {children}
      </View>
    </Pressable>
  );
}

/**
 * purpose: Render the conversation control bar.
 * @param props: ({ isText: boolean, onToggleMode: () => void }) whether the conversation is
 *               in text mode, and the handler that switches between voice and text
 * @return: (ReactElement) the bar
 */
export function ControlBar(props: { isText: boolean; onToggleMode: () => void }): ReactElement {
  const { isText, onToggleMode } = props;
  const { accentColor } = useTheme();
  const { isMicrophoneEnabled, toggleMicrophone, agentJoined, localAudioTrack } = useConversation();
  const { disconnect } = useVoice();

  return (
    <View style={styles.bar}>
      <ControlButton
        label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
        symbol={isMicrophoneEnabled ? 'microphone.fill' : 'microphone.slash.fill'}
        onPress={() => {
          void toggleMicrophone();
        }}
        accentColor={accentColor}
      >
        <BarVisualizer
          trackRef={localAudioTrack}
          barCount={3}
          style={styles.meter}
          options={{ barColor: colors.text, barWidth: 3, barBorderRadius: 2, minHeight: 0.1 }}
        />
      </ControlButton>
      <ControlButton
        label={isText ? 'Switch to voice' : 'Switch to text'}
        symbol="ellipsis.message.fill"
        onPress={onToggleMode}
        disabled={!agentJoined}
        toggled={isText}
        accentColor={accentColor}
      />
      <ControlButton
        label="End conversation"
        symbol="phone.down.fill"
        onPress={() => {
          void disconnect();
        }}
        serious
        accentColor={accentColor}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    alignSelf: 'center',
    gap: 8,
    height: 60,
    paddingHorizontal: 8,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: colors.separator,
    backgroundColor: BACKGROUND,
    shadowColor: colors.ink,
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 10 },
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meter: { width: 12, height: 30 },
});
