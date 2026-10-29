// sunny_app/src/backend/pairing.ts
//
// Purpose: This device's pairing with a household, on Convex + Clerk. pair(code) POSTs
// { code, pairingNonce } to the backend's /pair HTTP action and signs in to Clerk with the
// returned ticket; Convex auth then follows reactively.
//
// Same-nonce retry: the nonce is created when a code is first tried and kept with the code in
// AsyncStorage until pairing succeeds. Submitting the SAME code again within 10 minutes resends
// the SAME nonce, so a lost response recovers (a fresh ticket for the same device) instead of 404.
//
// Pairing rule (decidePairing): no pairing is stored locally. "Unpaired" means Clerk has loaded
// and has no session; a Convex auth blip (Clerk cannot mint the "convex" JWT: offline, network
// error, Clerk 5xx) never shows the code screen. With a Clerk session but no Convex auth the app
// keeps the last device seen in this run (in memory only) or shows the loading view, so an
// offline cold start stays on the loading view until Clerk and Convex answer. A device is paired
// when households.mine has an entry with a deviceKind; signed in but no such entry (the device
// was removed, or a caregiver account is signed in) means "removed": the app unpairs it, retrying
// with a capped backoff (removalRetryDelay) until the session is gone. unpair() unregisters the
// stored push token first (the device row survives a local unpair, so the server could not
// reclaim the token later) and never rejects.
//
// Last modified: 2026-10-29

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getClerkInstance } from '@clerk/expo';
import type { FunctionReturnType } from 'convex/server';
import * as Crypto from 'expo-crypto';

import { CONVEX_SITE_URL } from '../config';
import { logger } from '../logging/logger';
import { unregisterStoredPushToken } from '../notifications/push';
import { BackendError, GENERIC_ERROR_MESSAGE, OFFLINE_ERROR_MESSAGE } from './api';
import { api, type HouseholdId } from './convexApi';

/** One entry of the households.mine query. */
export type MineEntry = FunctionReturnType<typeof api.households.mine>[number];

/** What kind of senior device this is, as recorded by the join code. */
type DeviceKind = NonNullable<MineEntry['deviceKind']>;

/** This device's pairing with a household. */
export interface PairedDevice {
  householdId: HouseholdId;
  kind: DeviceKind;
}

/** What the app should show, as decided by decidePairing. */
export type PairingDecision =
  | { state: 'loading'; notice?: string }
  | { state: 'unpaired' }
  | { state: 'paired'; device: PairedDevice }
  | { state: 'removed' };

/** The pending pairing attempt kept until pairing succeeds. */
interface PairingAttempt {
  code: string;
  nonce: string;
  createdAt: number;
}

const ATTEMPT_KEY = 'sunny.pairingAttempt';
/** The server accepts a retry with the same nonce for 10 minutes. */
const NONCE_TTL_MS = 10 * 60 * 1000;
/** How long /pair may take, request and response body together, before it is abandoned. */
const PAIR_TIMEOUT_MS = 20_000;
/** Shown when the ticket sign-in does not complete. */
const SIGN_IN_FAILED_MESSAGE = 'Could not finish connecting this device. Please try again.';
/** Shown when /pair did not answer within PAIR_TIMEOUT_MS. */
const PAIR_TIMEOUT_MESSAGE = 'Connecting took too long. Please try again.';
/** Calm one-line notice under the loading view when the backend cannot be reached. */
export const UNREACHABLE_NOTICE = "Can't reach Sunny right now. Retrying...";
/** Delays before each retry of a removal unpair; the last one repeats. */
const REMOVAL_RETRY_DELAYS_MS = [2000, 5000, 15_000, 30_000];
/** The unpair run in progress, shared by concurrent unpair() and awaited by pair(). */
let unpairRun: Promise<void> | null = null;

/** Everything decidePairing looks at. */
export interface PairingInputs {
  /** Clerk has finished loading. */
  clerkLoaded: boolean;
  /** Clerk has a signed-in session. */
  clerkSignedIn: boolean;
  /** Convex has finished establishing (or rejecting) the session. */
  convexLoading: boolean;
  /** Convex has confirmed the session. */
  convexAuthenticated: boolean;
  /** The households.mine result; undefined while it is skipped, loading or failed. */
  mine: MineEntry[] | undefined;
  /** The households.mine query failed. */
  mineFailed: boolean;
  /** The last paired device seen in this app run (memory only), or null. */
  lastDevice: PairedDevice | null;
}

/**
 * purpose: Derive what the app should show from the Clerk session, Convex auth and the
 *          households.mine result. Only Clerk decides "unpaired": a Convex auth failure with a
 *          Clerk session is treated as a transient connection problem. A signed-in account
 *          without a device entry (the device was removed, or a caregiver session) is "removed"
 *          and gets signed out.
 * @param inputs: (PairingInputs) The auth state, the mine result and the last device seen.
 * @return: (PairingDecision) loading (not settled; may carry a notice when the backend is
 *          unreachable), unpaired (Clerk loaded without a session: show the pairing screen),
 *          paired (an entry has a deviceKind, or mine is unavailable and a device was seen
 *          earlier in this run), or removed (the caller should unpair).
 */
export function decidePairing(inputs: PairingInputs): PairingDecision {
  const { clerkLoaded, clerkSignedIn, convexLoading, convexAuthenticated, mine, lastDevice } =
    inputs;
  if (!clerkLoaded) return { state: 'loading' };
  if (!clerkSignedIn) return { state: 'unpaired' };
  const unavailable = (notice: boolean): PairingDecision =>
    lastDevice !== null
      ? { state: 'paired', device: lastDevice }
      : notice
        ? { state: 'loading', notice: UNREACHABLE_NOTICE }
        : { state: 'loading' };
  if (!convexAuthenticated) return unavailable(!convexLoading);
  if (mine === undefined) return unavailable(inputs.mineFailed);
  const entry = mine.find((e) => e.deviceKind !== null);
  if (entry === undefined || entry.deviceKind === null) return { state: 'removed' };
  return { state: 'paired', device: { householdId: entry.household._id, kind: entry.deviceKind } };
}

/**
 * purpose: Update the remembered device after a decision: remember a paired device, forget it
 *          once the device is unpaired or removed, otherwise keep it.
 * @param decision: (PairingDecision) The latest decision.
 * @param last: (PairedDevice | null) The device remembered so far.
 * @return: (PairedDevice | null) The device to remember; `last` itself when nothing changed.
 */
export function rememberDevice(
  decision: PairingDecision,
  last: PairedDevice | null,
): PairedDevice | null {
  if (decision.state === 'paired') {
    const same =
      last !== null &&
      last.householdId === decision.device.householdId &&
      last.kind === decision.device.kind;
    return same ? last : decision.device;
  }
  return decision.state === 'loading' ? last : null;
}

/**
 * purpose: Delay before retrying an unpair that did not end the session.
 * @param attempt: (number) Zero-based retry number.
 * @return: (number) Milliseconds: 2 s, 5 s, 15 s, then 30 s for every later retry.
 */
export function removalRetryDelay(attempt: number): number {
  const last = REMOVAL_RETRY_DELAYS_MS.length - 1;
  return REMOVAL_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), last)] ?? 30_000;
}

/**
 * purpose: Make a random pairing nonce from a CSPRNG (Hermes has no crypto.getRandomValues).
 * @return: (string) A random UUID (36 characters, within the server's 16 to 128 limit).
 */
function makeNonce(): string {
  return Crypto.randomUUID();
}

/**
 * purpose: Read the pending pairing attempt.
 * @return: (Promise<PairingAttempt | null>) The attempt, or null when none is stored or it is
 *          malformed.
 */
async function loadAttempt(): Promise<PairingAttempt | null> {
  const raw = await AsyncStorage.getItem(ATTEMPT_KEY);
  if (raw === null) return null;
  try {
    const { code, nonce, createdAt } = JSON.parse(raw) as Record<string, unknown>;
    if (typeof code !== 'string' || typeof nonce !== 'string' || typeof createdAt !== 'number') {
      return null;
    }
    return { code, nonce, createdAt };
  } catch {
    return null;
  }
}

/**
 * purpose: Get the nonce to send for a code: the stored one when the same code was tried
 *          within the last 10 minutes (so a retry after a lost response is recognized),
 *          otherwise a new one, which is stored.
 * @param code: (string) The cleaned join code.
 * @param now: (number) Current time in epoch milliseconds.
 * @return: (Promise<string>) The nonce.
 */
export async function nonceForCode(code: string, now: number = Date.now()): Promise<string> {
  const attempt = await loadAttempt();
  if (attempt !== null && attempt.code === code && now - attempt.createdAt < NONCE_TTL_MS) {
    return attempt.nonce;
  }
  const fresh: PairingAttempt = { code, nonce: makeNonce(), createdAt: now };
  await AsyncStorage.setItem(ATTEMPT_KEY, JSON.stringify(fresh));
  return fresh.nonce;
}

/**
 * purpose: Read the sign-in ticket from a parsed /pair success body.
 * @param value: (unknown) The parsed JSON.
 * @return: (string | null) The ticket, or null when it is missing or empty.
 */
function readTicket(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { ticket } = value as Record<string, unknown>;
  return typeof ticket === 'string' && ticket !== '' ? ticket : null;
}

/**
 * purpose: Turn a failed /pair answer into a BackendError carrying the server's message.
 * @param status: (number) The HTTP status.
 * @param body: (unknown) The parsed JSON body, or null when it was missing or unreadable.
 * @return: (BackendError) Error with body.error.message (generic when absent) and the status.
 */
export function pairErrorFromBody(status: number, body: unknown): BackendError {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return new BackendError(
    typeof message === 'string' && message !== '' ? message : GENERIC_ERROR_MESSAGE,
    status,
  );
}

/**
 * purpose: Tell whether a thrown value is a fetch abort (the timeout firing).
 * @param error: (unknown) The thrown value.
 * @return: (boolean) True for an error named AbortError.
 */
function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * purpose: Read a response body as JSON.
 * @param response: (Response) The response.
 * @return: (Promise<unknown>) The parsed body, or null when it is not JSON.
 * @raises: The abort error, so a timeout while reading is not mistaken for a bad body.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (e) {
    if (isAbortError(e)) throw e;
    return null;
  }
}

/**
 * purpose: POST the code and nonce to /pair. The timeout covers the response body too.
 * @param code: (string) The cleaned join code.
 * @param nonce: (string) The pairing nonce.
 * @return: (Promise<string>) The Clerk sign-in ticket.
 * @raises: BackendError with the server's message on a 4xx/5xx answer, the timeout message
 *          (status 0) when it took too long, or the offline message (status 0) when the
 *          request fails.
 */
async function requestPairing(code: string, nonce: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
  try {
    const response = await fetch(`${CONVEX_SITE_URL}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, pairingNonce: nonce }),
      signal: controller.signal,
    });
    const body = await readJson(response);
    if (!response.ok) throw pairErrorFromBody(response.status, body);
    const ticket = readTicket(body);
    if (ticket === null) throw new BackendError(GENERIC_ERROR_MESSAGE, response.status);
    return ticket;
  } catch (e) {
    if (e instanceof BackendError) throw e;
    throw new BackendError(isAbortError(e) ? PAIR_TIMEOUT_MESSAGE : OFFLINE_ERROR_MESSAGE, 0);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * purpose: Describe a thrown value for a log line.
 * @param e: (unknown) The thrown value.
 * @return: (string) Its message, or "error".
 */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : 'error';
}

/**
 * purpose: Run one cleanup step, logging instead of throwing.
 * @param label: (string) What the step does, for the log line.
 * @param step: (() => Promise<unknown>) The step.
 * @return: (Promise<void>) Always resolves.
 */
async function attempt(label: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (e) {
    logger.warning('Pairing', `Unpair step failed (${label}): ${describe(e)}`);
  }
}

/**
 * purpose: Sign in to Clerk with a sign-in ticket and make that session the active one. Any
 *          existing session is signed out first.
 * @param ticket: (string) The ticket from /pair.
 * @raises: BackendError when the sign-in does not complete.
 */
async function signInWithTicket(ticket: string): Promise<void> {
  const clerk = getClerkInstance();
  try {
    if (!clerk.client) throw new Error('Clerk client is not ready');
    if (clerk.session) {
      // The new session replaces a stale one, so a failing sign out must not fail the pairing.
      await clerk.signOut().catch((e: unknown) => {
        logger.warning('Pairing', `Stale session sign out failed: ${describe(e)}`);
      });
    }
    const signIn = await clerk.client.signIn.create({ strategy: 'ticket', ticket });
    if (signIn.status !== 'complete' || !signIn.createdSessionId) {
      throw new Error(`Sign-in ended with status ${signIn.status}`);
    }
    await clerk.setActive({ session: signIn.createdSessionId });
  } catch (e) {
    logger.warning('Pairing', `Ticket sign-in failed: ${describe(e)}`);
    throw new BackendError(SIGN_IN_FAILED_MESSAGE, 0);
  }
}

/**
 * purpose: Pair this device: redeem the join code at /pair (resending the same nonce on a retry
 *          of the same code) and sign in to Clerk with the returned ticket. The reactive Convex
 *          auth and households.mine take over from there.
 * @param code: (string) The 8-character join code (case, spaces and dashes ignored).
 * @return: (Promise<void>) Resolves once the Clerk session is active.
 * @raises: BackendError with a message safe to show when the code is rejected, the network
 *          fails, or the sign-in does not complete (the nonce is kept so a retry works).
 */
export async function pair(code: string): Promise<void> {
  if (unpairRun !== null) await unpairRun;
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nonce = await nonceForCode(cleaned);
  const ticket = await requestPairing(cleaned, nonce);
  await signInWithTicket(ticket);
  await AsyncStorage.removeItem(ATTEMPT_KEY);
}

/**
 * purpose: Run the unpair steps: with a session, unregister the push token while still signed
 *          in, then forget the pending attempt and sign out of Clerk. Every step is isolated, so
 *          a failure never stops the sign out.
 * @return: (Promise<void>) Always resolves; failures are logged.
 */
async function runUnpair(): Promise<void> {
  let hasSession = false;
  await attempt('read session', async () => {
    hasSession = Boolean(getClerkInstance().session);
  });
  if (hasSession) await attempt('unregister push token', unregisterStoredPushToken);
  await attempt('clear pairing attempt', () => AsyncStorage.removeItem(ATTEMPT_KEY));
  if (hasSession) await attempt('sign out', () => getClerkInstance().signOut());
}

/**
 * purpose: Forget the session so the device can be paired again; Convex auth then reports
 *          unauthenticated and the app shows the pairing screen. Concurrent calls share one run.
 * @return: (Promise<void>) Resolves when the steps are done; never rejects.
 */
export function unpair(): Promise<void> {
  unpairRun ??= runUnpair().finally(() => {
    unpairRun = null;
  });
  return unpairRun;
}
