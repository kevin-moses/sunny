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
// Session rule (decideSession): no pairing or role is stored locally. "Signed out" means Clerk
// has loaded and has no session; a Convex auth blip (Clerk cannot mint the "convex" JWT:
// offline, network error, Clerk 5xx) never shows the welcome screen. With a Clerk session but
// no Convex auth or no households.mine answer, decideSession reports loading (with a calm notice
// when the backend looks unreachable), and useSession keeps the last home seen in this run (a
// paired device or a caregiver household, in a ref only) on screen meanwhile, so an offline
// cold start stays on the loading view until Clerk and Convex answer. Once mine answers, its
// accountKind decides the role. A "device" is paired when a mine household has a deviceKind;
// without one (the device was removed) it is "removed": the app unpairs it, retrying with a
// capped backoff (removalRetryDelay) until the session is gone. A "caregiver" with a mine
// household that has a role is in that household (the first such entry); a caregiver without one
// needs onboarding (join or create a household). rememberHome and showHome hold the
// remembered-home rule as pure functions.
//
// unpair() unregisters the stored push token first (the device row survives a local
// unpair, so the server could not reclaim the token later), drops the queued Done presses
// (pair() clears them again, so a new pairing starts empty) and never rejects.
//
// Last modified: 2026-11-09

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getClerkInstance } from '@clerk/expo';
import type { FunctionReturnType } from 'convex/server';
import * as Crypto from 'expo-crypto';

import { CONVEX_SITE_URL } from '../config';
import { logger } from '../logging/logger';
import { confirmQueue } from '../day/pendingConfirms';
import { unregisterStoredPushToken } from '../notifications/push';
import { BackendError, GENERIC_ERROR_MESSAGE, OFFLINE_ERROR_MESSAGE } from './api';
import { api, type HouseholdId } from './convexApi';

/** The households.mine result: the account kind and its households. */
export type MineResult = FunctionReturnType<typeof api.households.mine>;

/** One household entry of the households.mine query. */
export type MineEntry = MineResult['households'][number];

/** What kind of account is signed in, as reported by households.mine. */
export type AccountKind = NonNullable<MineResult['accountKind']>;

/** What kind of senior device this is, as recorded by the join code. */
type DeviceKind = NonNullable<MineEntry['deviceKind']>;

/** This device's pairing with a household. */
export interface PairedDevice {
  householdId: HouseholdId;
  kind: DeviceKind;
}

/** A caregiver's role in a household, as recorded by households.mine. */
export type CaregiverRole = NonNullable<MineEntry['role']>;

/** The household a signed-in caregiver is in, and their role there. */
export interface CaregiverHome {
  householdId: HouseholdId;
  role: CaregiverRole;
}

/** What the app should show, as decided by decideSession. */
export type SessionDecision =
  | { state: 'loading'; notice?: string }
  | { state: 'signedOut' }
  | { state: 'paired'; device: PairedDevice }
  | { state: 'removed' }
  | { state: 'caregiver'; home: CaregiverHome }
  | { state: 'caregiverOnboarding' };

/** A decision that shows a home screen; remembered so a connection blip keeps it. */
export type HomeDecision = Extract<SessionDecision, { state: 'paired' | 'caregiver' }>;

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

/** Everything decideSession looks at. */
export interface SessionInputs {
  /** Clerk has finished loading. */
  clerkLoaded: boolean;
  /** Clerk has a signed-in session. */
  clerkSignedIn: boolean;
  /** Convex has finished establishing (or rejecting) the session. */
  convexLoading: boolean;
  /** Convex has confirmed the session. */
  convexAuthenticated: boolean;
  /** The households.mine result; undefined while it is skipped, loading or failed. */
  mine: MineResult | undefined;
  /** The households.mine query failed. */
  queryFailed: boolean;
}

/**
 * purpose: Derive what the app should show from the Clerk session, Convex auth and the
 *          households.mine result. Only Clerk decides "signed out": a Convex auth failure with
 *          a Clerk session is treated as a transient connection problem.
 * @param inputs: (SessionInputs) The auth state and the query result.
 * @return: (SessionDecision) loading (not settled; carries a notice when the backend looks
 *          unreachable), signedOut (Clerk loaded without a session: show the welcome screen),
 *          paired (a device whose household entry has a deviceKind), removed (a device without
 *          one; the caller should unpair), caregiver (a caregiver whose first household entry
 *          with a role gives the household and role) or caregiverOnboarding (a caregiver with
 *          no such entry).
 */
export function decideSession(inputs: SessionInputs): SessionDecision {
  const { clerkLoaded, clerkSignedIn, convexLoading, convexAuthenticated, mine } = inputs;
  if (!clerkLoaded) return { state: 'loading' };
  if (!clerkSignedIn) return { state: 'signedOut' };
  const unreachable: SessionDecision = { state: 'loading', notice: UNREACHABLE_NOTICE };
  if (!convexAuthenticated) return convexLoading ? { state: 'loading' } : unreachable;
  if (mine === undefined) return inputs.queryFailed ? unreachable : { state: 'loading' };
  // Convex is authenticated yet reports no account: a transient mismatch, not a role.
  if (mine.accountKind === null) return unreachable;
  if (mine.accountKind === 'device') {
    const entry = mine.households.find((e) => e.deviceKind !== null);
    if (!entry?.deviceKind) return { state: 'removed' };
    return {
      state: 'paired',
      device: { householdId: entry.household._id, kind: entry.deviceKind },
    };
  }
  const member = mine.households.find((e) => e.role !== null);
  if (!member?.role) return { state: 'caregiverOnboarding' };
  return { state: 'caregiver', home: { householdId: member.household._id, role: member.role } };
}

/**
 * purpose: Update the remembered home after a decision: remember a paired device or caregiver
 *          household, keep it while loading, forget it on any other decision (signed out,
 *          removed, onboarding).
 * @param decision: (SessionDecision) The latest decision.
 * @param last: (HomeDecision | null) The home remembered so far.
 * @return: (HomeDecision | null) The home to remember.
 */
export function rememberHome(
  decision: SessionDecision,
  last: HomeDecision | null,
): HomeDecision | null {
  if (decision.state === 'paired' || decision.state === 'caregiver') return decision;
  return decision.state === 'loading' ? last : null;
}

/**
 * purpose: Pick what to show: the remembered home while the decision is loading (a connection
 *          blip must not unmount a home screen), otherwise the decision itself.
 * @param decision: (SessionDecision) The latest decision.
 * @param last: (HomeDecision | null) The home remembered before this decision.
 * @return: ({shown, remembered}) The decision to show and the home to remember from now on.
 */
export function showHome(
  decision: SessionDecision,
  last: HomeDecision | null,
): { shown: SessionDecision; remembered: HomeDecision | null } {
  const remembered = rememberHome(decision, last);
  return { shown: decision.state === 'loading' && remembered ? remembered : decision, remembered };
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
  // A new pairing always starts with an empty queue of Done presses, even if unpair's clear failed.
  await confirmQueue.clear();
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nonce = await nonceForCode(cleaned);
  const ticket = await requestPairing(cleaned, nonce);
  await signInWithTicket(ticket);
  await AsyncStorage.removeItem(ATTEMPT_KEY);
}

/**
 * purpose: Run the unpair steps: with a session, unregister the push token while still signed
 *          in, then forget the pending attempt, drop the queued Done presses (they belong to
 *          this pairing and must never be sent or shown under another) and sign out of Clerk.
 *          Every step is isolated, so a failure never stops the sign out.
 * @return: (Promise<void>) Always resolves; failures are logged.
 */
async function runUnpair(): Promise<void> {
  let hasSession = false;
  await attempt('read session', async () => {
    hasSession = Boolean(getClerkInstance().session);
  });
  if (hasSession) await attempt('unregister push token', unregisterStoredPushToken);
  await attempt('clear pairing attempt', () => AsyncStorage.removeItem(ATTEMPT_KEY));
  await attempt('clear pending confirms', () => confirmQueue.clear());
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
