import AsyncStorage from '@react-native-async-storage/async-storage';
import { getClerkInstance } from '@clerk/expo';
import type { FunctionReturnType } from 'convex/server';
import * as Crypto from 'expo-crypto';

import { CONVEX_SITE_URL } from '../config';
import { logger } from '../logging/logger';
import { confirmQueue } from '../day/pendingConfirms';
import { withTimeout } from '../day/withTimeout';
import { unregisterStoredPushToken } from '../notifications/push';
import { clearWidget } from '../widget/widgetSync';
import { BackendError, GENERIC_ERROR_MESSAGE, OFFLINE_ERROR_MESSAGE, callMutation } from './api';
import { api, type HouseholdId } from './convexApi';

export type MineResult = FunctionReturnType<typeof api.households.mine>;

export type MineEntry = MineResult['households'][number];

export type AccountKind = NonNullable<MineResult['accountKind']>;

type DeviceKind = NonNullable<MineEntry['deviceKind']>;

export interface PairedDevice {
  householdId: HouseholdId;
  kind: DeviceKind;
}

export type CaregiverRole = NonNullable<MineEntry['role']>;

export interface CaregiverHome {
  householdId: HouseholdId;
  role: CaregiverRole;
}

export type SessionDecision =
  | { state: 'loading'; notice?: string }
  | { state: 'signedOut' }
  | { state: 'paired'; device: PairedDevice }
  | { state: 'removed' }
  | { state: 'caregiver'; home: CaregiverHome }
  | { state: 'caregiverOnboarding' };

export type HomeDecision = Extract<SessionDecision, { state: 'paired' | 'caregiver' }>;

interface PairingAttempt {
  code: string;
  nonce: string;
  createdAt: number;
}

const ATTEMPT_KEY = 'sunny.pairingAttempt';
const NONCE_TTL_MS = 10 * 60 * 1000;
const PAIR_TIMEOUT_MS = 20_000;
const SIGN_IN_FAILED_MESSAGE = 'Could not finish connecting this device. Please try again.';
const PAIR_TIMEOUT_MESSAGE = 'Connecting took too long. Please try again.';
export const UNREACHABLE_NOTICE = "Can't reach Sunny right now. Retrying...";
const REMOVAL_RETRY_DELAYS_MS = [2000, 5000, 15_000, 30_000];
export const UNPAIR_SEND_MS = 3000;
let unpairRun: Promise<void> | null = null;

export interface SessionInputs {
  clerkLoaded: boolean;
  clerkSignedIn: boolean;
  convexLoading: boolean;
  convexAuthenticated: boolean;
  mine: MineResult | undefined;
  queryFailed: boolean;
}

export function decideSession(inputs: SessionInputs): SessionDecision {
  const { clerkLoaded, clerkSignedIn, convexLoading, convexAuthenticated, mine } = inputs;
  if (!clerkLoaded) return { state: 'loading' };
  if (!clerkSignedIn) return { state: 'signedOut' };
  const unreachable: SessionDecision = { state: 'loading', notice: UNREACHABLE_NOTICE };
  if (!convexAuthenticated) return convexLoading ? { state: 'loading' } : unreachable;
  if (mine === undefined) return inputs.queryFailed ? unreachable : { state: 'loading' };
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

export function homeOf(decision: SessionDecision): HomeDecision | null | undefined {
  if (decision.state === 'paired' || decision.state === 'caregiver') return decision;
  return decision.state === 'loading' ? undefined : null;
}

export function removalRetryDelay(attempt: number): number {
  const last = REMOVAL_RETRY_DELAYS_MS.length - 1;
  return REMOVAL_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), last)] ?? 30_000;
}

function makeNonce(): string {
  return Crypto.randomUUID();
}

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

export async function nonceForCode(code: string, now: number = Date.now()): Promise<string> {
  const attempt = await loadAttempt();
  if (attempt !== null && attempt.code === code && now - attempt.createdAt < NONCE_TTL_MS) {
    return attempt.nonce;
  }
  const fresh: PairingAttempt = { code, nonce: makeNonce(), createdAt: now };
  await AsyncStorage.setItem(ATTEMPT_KEY, JSON.stringify(fresh));
  return fresh.nonce;
}

function readTicket(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { ticket } = value as Record<string, unknown>;
  return typeof ticket === 'string' && ticket !== '' ? ticket : null;
}

export function pairErrorFromBody(status: number, body: unknown): BackendError {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return new BackendError(
    typeof message === 'string' && message !== '' ? message : GENERIC_ERROR_MESSAGE,
    status,
  );
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (e) {
    if (isAbortError(e)) throw e;
    return null;
  }
}

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

function describe(e: unknown): string {
  return e instanceof Error ? e.message : 'error';
}

async function attempt(label: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (e) {
    logger.warning('Pairing', `Unpair step failed (${label}): ${describe(e)}`);
  }
}

async function signInWithTicket(ticket: string): Promise<void> {
  const clerk = getClerkInstance();
  try {
    if (!clerk.client) throw new Error('Clerk client is not ready');
    if (clerk.session) {
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

export async function pair(code: string): Promise<void> {
  if (unpairRun !== null) await unpairRun;
  await confirmQueue.clear();
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nonce = await nonceForCode(cleaned);
  const ticket = await requestPairing(cleaned, nonce);
  await signInWithTicket(ticket);
  await AsyncStorage.removeItem(ATTEMPT_KEY);
}

async function runUnpair(): Promise<void> {
  let hasSession = false;
  await attempt('read session', async () => {
    hasSession = Boolean(getClerkInstance().session);
  });
  if (hasSession) await attempt('unregister push token', unregisterStoredPushToken);
  await attempt('clear pairing attempt', () => AsyncStorage.removeItem(ATTEMPT_KEY));
  await attempt('send pending confirms', () =>
    withTimeout(confirmQueue.replay(), UNPAIR_SEND_MS, 'Sending the queued presses took too long'),
  );
  await attempt('clear pending confirms', () => confirmQueue.clear());
  await attempt('clear widget', clearWidget);
  if (hasSession) {
    await attempt('revoke device token', () => callMutation(api.deviceApi.revokeOwnToken, {}));
    await attempt('sign out', () => getClerkInstance().signOut());
  }
}

export function unpair(): Promise<void> {
  unpairRun ??= runUnpair().finally(() => {
    unpairRun = null;
  });
  return unpairRun;
}
