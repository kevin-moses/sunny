// sunny_app/src/voice/AgentListeningHint.tsx
//
// Purpose: Hint shown in voice mode until the first transcript arrives ("Agent is listening,
// start talking"): a gently pulsing line of text, still when Reduce Motion is on,
// announced to VoiceOver as "Sunny is listening".
//
// Last modified: 2026-10-28

import { useEffect, useState, type ReactElement } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { colors } from '../theme/colors';
import { useReduceMotion } from '../theme/useReduceMotion';

/** Duration of one half of the pulse, in milliseconds. */
const PULSE_MS = 900;

/**
 * purpose: Show the listening hint, pulsing unless Reduce Motion is enabled.
 * @return: (ReactElement) the hint text
 */
export function AgentListeningHint(): ReactElement {
  const reduceMotion = useReduceMotion();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.4, duration: PULSE_MS, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: PULSE_MS, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, opacity]);

  return (
    <Animated.Text
      style={[styles.text, { opacity }]}
      accessibilityLabel="Sunny is listening"
      accessibilityRole="text"
    >
      Agent is listening, start talking
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 15, color: colors.secondaryText, textAlign: 'center' },
});
