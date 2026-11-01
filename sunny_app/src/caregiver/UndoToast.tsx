// sunny_app/src/caregiver/UndoToast.tsx
//
// Purpose: The calm dark pill shown at the bottom of the caregiver Home tab for the undo window
// after a task is ticked: "Task completed" and an accent-colored Undo button. It sits above the
// floating tab bar, slides up and fades in (just appears when Reduce Motion is on), and is
// announced to screen readers as "Task completed. Undo available." (a polite live region on
// Android, an explicit announcement on iOS).
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { useReduceMotion } from '../theme/useReduceMotion';
import { type } from '../theme/typography';

/** Dark pill background: ink at about 90% opacity. */
const TOAST_BACKGROUND = 'rgba(0,0,0,0.9)';

/** What a screen reader says when the toast appears. */
const ANNOUNCEMENT = 'Task completed. Undo available.';

/**
 * purpose: Render the undo toast. Mount it only while a completion is pending.
 * @param props: ({ bottom: number, onUndo: () => void }) The space (points) to leave under the
 *        toast (the tab bar's clearance) and the Undo handler.
 * @return: (JSX.Element) The toast.
 */
export function UndoToast({ bottom, onUndo }: { bottom: number; onUndo: () => void }) {
  const { accentColor } = useTheme();
  const reduceMotion = useReduceMotion();
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(ANNOUNCEMENT);
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [progress, reduceMotion]);

  return (
    <Animated.View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={ANNOUNCEMENT}
      style={[
        styles.toast,
        {
          bottom,
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          ],
        },
      ]}
    >
      <Text style={[type.callout, styles.message]}>Task completed</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Undo"
        hitSlop={8}
        onPress={onUndo}
        style={({ pressed }) => [styles.undo, pressed && styles.pressed]}
      >
        <SymbolView name="arrow.uturn.backward" size={16} tintColor={accentColor} />
        <Text style={[type.button, { color: accentColor }]}>Undo</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 24,
    right: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: TOAST_BACKGROUND,
  },
  message: { color: colors.surface, flexShrink: 1 },
  undo: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  pressed: { opacity: 0.6 },
});
