import { BarVisualizer } from '@livekit/react-native';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { useReduceMotion } from '../theme/useReduceMotion';
import { useConversation } from './voiceContext';

const FULL_SIZE = { width: 300, height: 192 } as const;
const PLACEHOLDER_SIZE = { width: 42, height: 192 } as const;
const BAR_WIDTH = 24;

export function AgentVisualizer(): ReactElement {
  const { accentColor } = useTheme();
  const reduceMotion = useReduceMotion();
  const { agentAudioTrack, agentState } = useConversation();

  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={`Sunny is ${agentState}`}
      accessibilityRole="image"
    >
      {agentAudioTrack ? (
        <BarVisualizer
          state={reduceMotion ? undefined : agentState}
          trackRef={agentAudioTrack}
          barCount={5}
          style={FULL_SIZE}
          options={{ barColor: accentColor, barWidth: BAR_WIDTH, minHeight: 0.1 }}
        />
      ) : (
        <BarVisualizer
          state={reduceMotion ? undefined : 'listening'}
          barCount={1}
          style={PLACEHOLDER_SIZE}
          options={{ barColor: accentColor, barWidth: BAR_WIDTH, minHeight: 0.1 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
});
