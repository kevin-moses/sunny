// sunny_app/src/screens/DevTools.tsx
//
// Purpose: Debug-only developer tools (App.tsx mounts them only in __DEV__ builds): a floating
// "DEV" pill at the top right that opens the developer settings sheet in a modal. On the home
// display a plain tap does nothing; the pill opens the sheet only after it is held for
// DISPLAY_DEV_HOLD_MS, so the senior cannot open it by accident, and the sheet then adds the
// display's tunables. On other surfaces a tap opens it.
//
// Last modified: 2026-11-09

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { DevSettingsSheet } from './DevSettingsSheet';

/** How long (ms) the DEV pill must be held on the home display to open the sheet. */
export const DISPLAY_DEV_HOLD_MS = 2_000;

/**
 * purpose: The DEV pill and the developer settings modal it opens.
 * @param props: ({ display: boolean }) Whether this is the paired home display.
 * @return: (JSX.Element) The pill and the modal.
 */
export function DevTools({ display }: { display: boolean }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  /**
   * purpose: Open the sheet.
   * @return: (void)
   */
  const openSheet = (): void => setOpen(true);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open developer settings"
        accessibilityHint={display ? 'Press and hold' : undefined}
        onPress={display ? undefined : openSheet}
        onLongPress={display ? openSheet : undefined}
        delayLongPress={DISPLAY_DEV_HOLD_MS}
        style={[styles.pill, { top: insets.top + 8, borderColor: `${theme.accentColor}66` }]}
      >
        <View style={[styles.dot, { backgroundColor: theme.accentColor }]} />
        <Text style={styles.pillText}>DEV</Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <DevSettingsSheet display={display} onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: colors.overlayStrong,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontFamily: 'Menlo', fontSize: 11, fontWeight: '700', color: colors.text },
});
