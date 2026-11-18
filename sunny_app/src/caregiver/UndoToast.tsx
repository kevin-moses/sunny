import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text } from 'react-native';

import { colors, GRID } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';

const ANNOUNCEMENT = 'Task completed. Undo available.';

const SLIDE_DISTANCE = 6 * GRID;

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
