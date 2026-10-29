// sunny_app/src/voice/AgentVisualizer.tsx
//
// Purpose: The agent's presence in the conversation (audio only; Sunny's agent has no
// avatar video). Once the agent's audio track
// exists it shows a 5-bar BarVisualizer in the accent color driven by the agent state and
// audio. Before that, while a session is live, it shows a single placeholder bar. With
// Reduce Motion on, bars follow volume only (no state sequencing).
//
// Last modified: 2026-10-28

import { BarVisualizer } from '@livekit/react-native';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { useReduceMotion } from '../theme/useReduceMotion';
import { useConversation } from './voiceContext';

/** Full visualizer size: 75 x 48 grid units of 4 points. */
const FULL_SIZE = { width: 300, height: 192 } as const;
/** Placeholder visualizer size: 10.5 x 48 grid units. */
const PLACEHOLDER_SIZE = { width: 42, height: 192 } as const;
const BAR_WIDTH = 24;

/**
 * purpose: Render the agent visualizer for the current agent audio state.
 * @return: (ReactElement) the visualizer, or an empty view before any audio exists
 */
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
