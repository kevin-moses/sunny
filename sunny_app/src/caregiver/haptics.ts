// sunny_app/src/caregiver/haptics.ts
//
// Purpose: Tiny, crash-proof haptic feedback for the caregiver Home tab: a light tap when a task
// is ticked (tapHaptic) and a selection click when the tick is undone (undoHaptic). expo-haptics
// is a native module, and a dev build made before it was added does not contain it, so it is
// loaded lazily with a guarded require on first use and cached. Any failure (missing module, a
// call that throws or rejects) is swallowed; the first failure is logged once at debug level.
//
// Last modified: 2026-11-01

import { logger } from '../logging/logger';

/** The part of expo-haptics this file uses. */
interface HapticsModule {
  impactAsync: (style: unknown) => Promise<void>;
  selectionAsync: () => Promise<void>;
  ImpactFeedbackStyle: { Light: unknown };
}

/** The loaded module, or null when loading failed or has not been tried yet. */
let cached: HapticsModule | null = null;

/** Whether loading has been tried (a failed load is not retried). */
let attempted = false;

/** Whether a failure has already been logged. */
let logged = false;

/**
 * purpose: Log a haptics failure once, at debug level.
 * @param error: (unknown) What went wrong.
 * @return: (void)
 */
function logOnce(error: unknown): void {
  if (logged) return;
  logged = true;
  logger.debug('Haptics', 'Haptic feedback unavailable', { error: String(error) });
}

/**
 * purpose: Load expo-haptics on first use and cache it; never throws.
 * @return: (HapticsModule | null) The module, or null when it is not available.
 */
function loadHaptics(): HapticsModule | null {
  if (attempted) return cached;
  attempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-haptics') as HapticsModule;
  } catch (error) {
    cached = null;
    logOnce(error);
  }
  return cached;
}

/**
 * purpose: Run a haptic call fire-and-forget, swallowing every failure.
 * @param run: ((haptics: HapticsModule) => Promise<void>) Starts the haptic call.
 * @return: (void)
 */
function fire(run: (haptics: HapticsModule) => Promise<void>): void {
  try {
    const haptics = loadHaptics();
    if (haptics === null) return;
    void Promise.resolve(run(haptics)).catch(logOnce);
  } catch (error) {
    logOnce(error);
  }
}

/**
 * purpose: Give a light tap, for when a task is ticked.
 * @return: (void)
 */
export function tapHaptic(): void {
  fire((haptics) => haptics.impactAsync(haptics.ImpactFeedbackStyle.Light));
}

/**
 * purpose: Give a selection click, for when a tick is undone.
 * @return: (void)
 */
export function undoHaptic(): void {
  fire((haptics) => haptics.selectionAsync());
}

/**
 * purpose: Forget the cached module and failure state, so tests can start clean.
 * @return: (void)
 */
export function resetHapticsForTests(): void {
  cached = null;
  attempted = false;
  logged = false;
}
