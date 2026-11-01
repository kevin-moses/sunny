// sunny_app/src/caregiver/haptics.ts
//
// Purpose: Tiny fire-and-forget haptic feedback for the caregiver Home tab: a light tap when a
// task is ticked (tapHaptic) and a selection click when the tick is undone (undoHaptic). A
// failing haptic call (for example a device without a haptic engine) is ignored.
//
// Last modified: 2026-11-01

import * as Haptics from 'expo-haptics';

/**
 * purpose: Give a light tap, for when a task is ticked.
 * @return: (void)
 */
export function tapHaptic(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/**
 * purpose: Give a selection click, for when a tick is undone.
 * @return: (void)
 */
export function undoHaptic(): void {
  Haptics.selectionAsync().catch(() => undefined);
}
