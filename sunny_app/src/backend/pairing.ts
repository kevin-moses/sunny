// sunny_app/src/backend/pairing.ts
//
// Purpose: This device's pairing with a household. A device signs in anonymously with
// Supabase Auth (no account for the senior), redeems a caregiver's join code once, and
// reads back its devices row (household and kind); the pairing is kept in AsyncStorage.
// The Keychain session survives an app reinstall but AsyncStorage does not, and
// devices.user_id is unique, so pair() and restorePairing() first look for an existing
// devices row for the session and adopt it instead of redeeming again (this also recovers
// from a redeem whose response was lost). A duplicate-key rejection gets a friendly message.
// Losing the pairing (a caregiver removed the device, unpair in dev settings, or Auth
// definitively rejecting the session, which supabase-js reports as SIGNED_OUT; never a
// network error) forgets it and notifies subscribers so the app returns to the pairing
// screen. A 403 from get_day_view also unpairs (done by the day hook). unpair() deletes the
// user's push_tokens rows, signs out locally, and only then notifies subscribers.
//
// Last modified: 2026-10-28

import AsyncStorage from '@react-native-async-storage/async-storage';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { deleteOwnPushTokens } from '../notifications/push';
import { BackendError, callRpc } from './api';
import { supabase } from './supabase';

/** What kind of senior device this is, as recorded by the join code. */
type DeviceKind = 'senior_phone' | 'home_display';

/** This device's pairing with a household. */
export interface PairedDevice {
  householdId: string;
  kind: DeviceKind;
}

const PAIRING_KEY = 'sunny.pairedDevice';
const DEVICE_KINDS: readonly string[] = ['senior_phone', 'home_display'];
const listeners = new Set<() => void>();

/**
 * purpose: Validate and narrow a parsed value to a PairedDevice.
 * @param value: (unknown) A parsed JSON value.
 * @return: (PairedDevice | null) The pairing, or null when the shape is wrong.
 */
function toPairedDevice(value: unknown): PairedDevice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { householdId, kind } = value as Record<string, unknown>;
  if (typeof householdId !== 'string' || householdId === '') return null;
  if (typeof kind !== 'string' || !DEVICE_KINDS.includes(kind)) return null;
  return { householdId, kind: kind as DeviceKind };
}

/**
 * purpose: Load the saved pairing.
 * @return: (Promise<PairedDevice | null>) The pairing, or null when this device is unpaired.
 */
export async function loadPairedDevice(): Promise<PairedDevice | null> {
  const raw = await AsyncStorage.getItem(PAIRING_KEY);
  if (raw === null) return null;
  try {
    return toPairedDevice(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * purpose: Call every pairing-lost subscriber.
 */
function notifyPairingLost(): void {
  listeners.forEach((listener) => listener());
}

/**
 * purpose: Subscribe to the pairing being lost.
 * @param listener: (() => void) Called when the pairing is dropped.
 * @return: (() => void) Function that removes the subscription.
 */
export function subscribePairingLost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * purpose: Return the signed-in user's id, signing in anonymously if there is no session.
 * @return: (Promise<string>) The Auth user id.
 * @raises: Error when anonymous sign-in fails.
 */
async function ensureUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;
  const { data: signedIn, error } = await supabase.auth.signInAnonymously();
  if (error || !signedIn.user) {
    throw new Error(error?.message ?? 'Could not start a session. Check the internet connection.');
  }
  return signedIn.user.id;
}

/**
 * purpose: Read the devices row of a user and narrow it to a pairing.
 * @param userId: (string) The Auth user id.
 * @return: (Promise<PairedDevice | null>) The pairing, or null when the user has no device row.
 * @raises: Error when the read fails.
 */
async function readOwnDevice(userId: string): Promise<PairedDevice | null> {
  const { data, error } = await supabase
    .from('devices')
    .select('household_id, kind')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  const row = (data as { household_id: string; kind: string }[] | null)?.[0];
  return row ? toPairedDevice({ householdId: row.household_id, kind: row.kind }) : null;
}

/**
 * purpose: Save a pairing for the next launch.
 * @param device: (PairedDevice) The pairing.
 * @return: (Promise<PairedDevice>) The same pairing.
 */
async function savePairing(device: PairedDevice): Promise<PairedDevice> {
  await AsyncStorage.setItem(PAIRING_KEY, JSON.stringify(device));
  return device;
}

/**
 * purpose: Tell whether an error is Postgres rejecting a duplicate key (23505), which
 *          PostgREST reports as HTTP 409 with a "duplicate key" message.
 * @param error: (unknown) The thrown value.
 * @return: (boolean) True for a duplicate-key rejection.
 */
function isDuplicateKeyError(error: unknown): boolean {
  if (!(error instanceof BackendError)) return false;
  return error.status === 409 || /23505|duplicate key/i.test(error.message);
}

/**
 * purpose: Adopt the devices row of the current session when this app has no saved pairing
 *          (for example after a reinstall: the Keychain session survives, AsyncStorage does
 *          not). Never throws; a failure is treated as unpaired.
 * @return: (Promise<PairedDevice | null>) The restored and saved pairing, or null when there
 *          is no session or no device row.
 */
export async function restorePairing(): Promise<PairedDevice | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) return null;
    const device = await readOwnDevice(userId);
    return device ? await savePairing(device) : null;
  } catch (e) {
    logger.warning('Pairing', `Could not restore the pairing: ${errorMessage(e)}`);
    return null;
  }
}

/**
 * purpose: Pair this device with a household: sign in anonymously if needed, adopt an
 *          existing device row of this session, otherwise redeem the join code and read the
 *          row back.
 * @param code: (string) The 8-character join code (case, spaces and dashes ignored).
 * @return: (Promise<PairedDevice>) The pairing, also saved for the next launch.
 * @raises: Error with a message safe to show when the code is rejected or no device row exists.
 */
export async function pair(code: string): Promise<PairedDevice> {
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const userId = await ensureUserId();
  let device = await readOwnDevice(userId);
  if (!device) {
    try {
      await callRpc<string>('redeem_join_code', { p_code: cleaned });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
      // A device row appeared meanwhile (for example a redeem whose response was lost).
      device = await readOwnDevice(userId);
      if (!device) throw new Error('This device is already connected to a family.');
    }
    device ??= await readOwnDevice(userId);
  }
  if (!device) throw new Error('This device is not connected to a family yet.');
  return savePairing(device);
}

/**
 * purpose: Forget the saved pairing.
 * @return: (Promise<boolean>) True when there was a saved pairing to forget.
 */
async function removeSavedPairing(): Promise<boolean> {
  if ((await AsyncStorage.getItem(PAIRING_KEY)) === null) return false;
  await AsyncStorage.removeItem(PAIRING_KEY);
  return true;
}

/**
 * purpose: Forget the pairing and the session (the caregiver can pair the device again)
 *          and tell subscribers to show the pairing screen. Order: delete this user's push
 *          tokens (they need the session), forget the saved pairing, wait for the local sign
 *          out, then notify subscribers once, so the pairing screen never starts a new
 *          sign-in while the old session is still being removed.
 */
export async function unpair(): Promise<void> {
  await deleteOwnPushTokens();
  const wasPaired = await removeSavedPairing();
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  if (wasPaired) notifyPairingLost();
}

/**
 * purpose: React to Auth reporting SIGNED_OUT: forget the saved pairing and notify.
 */
async function handleSignedOut(): Promise<void> {
  // unpair() removes the saved pairing before it signs out and notifies after the sign out,
  // so when this runs because of unpair() the key is already gone and this does nothing;
  // otherwise subscribers would be notified twice for one unpair.
  if (await removeSavedPairing()) notifyPairingLost();
}

// supabase-js emits SIGNED_OUT only when the session is gone for good (a definitive
// refresh failure or an explicit sign out), never for network errors. The callback must
// not call back into supabase.auth, so it only touches AsyncStorage.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') void handleSignedOut();
});
