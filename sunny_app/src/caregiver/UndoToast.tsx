// sunny_app/src/caregiver/UndoToast.tsx
//
// Purpose: The calm dark pill shown at the bottom of the caregiver Home tab for a few seconds
// after a task is ticked: "Task completed" and an accent-colored Undo button. It sits above the
// floating tab bar, slides up and fades in (just appears when Reduce Motion is on, which the
// screen passes in), and is announced to screen readers as "Task completed. Undo available."
// (a polite live region on Android, an explicit announcement on iOS).
//
// Last modified: 2026-11-01

import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text } from 'react-native';

import { colors, GRID } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';

/** What a screen reader says when the toast appears. */
const ANNOUNCEMENT = 'Task completed. Undo available.';

/** How far (points) the toast slides up while it fades in. */
const SLIDE_DISTANCE = 6 * GRID;

/**
 * purpose: Render the undo toast. Mount it only while a toast is showing.
 * @param props: ({ bottom: number, reduceMotion: boolean, onUndo: () => void }) The space
 *        (points) to leave under the toast (the tab bar's clearance), whether to skip the
 *        slide and fade, and the Undo handler.
 * @return: (JSX.Element) The toast.
 */
export function UndoToast({
  bottom,
  reduceMotion,
  onUndo,
}: {
  bottom: number;
  reduceMotion: boolean;
  onUndo: () => void;
}) {
  const { accentColor } = useTheme();
  const [motion] = useState(() => {
    const progress = new Animated.Value(0);
    const translateY = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [SLIDE_DISTANCE, 0],
    });
    return { progress, translateY };
  });

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(ANNOUNCEMENT);
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      motion.progress.setValue(1);
      return;
    }
    Animated.timing(motion.progress, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [motion, reduceMotion]);

  return (
    <Animated.View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={ANNOUNCEMENT}
      style={[
        styles.toast,
        { bottom, opacity: motion.progress, transform: [{ translateY: motion.translateY }] },
      ]}
    >
      <Text style={[type.callout, styles.message]}>Task completed</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Undo"
        hitSlop={2 * GRID}
        onPress={onUndo}
        style={({ pressed }) => [styles.undo, pressed && styles.pressed]}
      >
        <SymbolView name="arrow.uturn.backward" size={4 * GRID} tintColor={accentColor} />
        <Text style={[type.button, { color: accentColor }]}>Undo</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 6 * GRID,
    right: 6 * GRID,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 3 * GRID,
    minHeight: 12 * GRID,
    paddingVertical: 2.5 * GRID,
    paddingHorizontal: 4 * GRID,
    borderRadius: 3.5 * GRID,
    backgroundColor: colors.overlayInk,
  },
  message: { color: colors.surface, flexShrink: 1 },
  undo: { flexDirection: 'row', alignItems: 'center', gap: 1.5 * GRID, minHeight: 8 * GRID },
  pressed: { opacity: 0.6 },
});
