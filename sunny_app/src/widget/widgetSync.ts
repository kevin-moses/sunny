import SunnyWidget from '../../modules/sunny-widget';
import { BackendError, callAction } from '../backend/api';
import { api } from '../backend/convexApi';
import type { SessionDecision } from '../backend/pairing';
import { CONVEX_SITE_URL } from '../config';
import type { DayViewData } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

type WidgetHolder = 'seniorPhone' | 'none' | 'undecided';

const REFUSED_FOR_THIS_PAIRING = 403;

let issuingStopped = false;
let tokenRefused = false;
let syncRun: Promise<void> | null = null;
let generation = 0;
let storing: Promise<void> = Promise.resolve();

export function widgetHolderOf(decision: SessionDecision): WidgetHolder {
  switch (decision.state) {
    case 'paired':
      return decision.device.kind === 'senior_phone' ? 'seniorPhone' : 'none';
    case 'loading':
    case 'removed':
      return 'undecided';
    default:
      return 'none';
  }
}

export function surfaceSyncKey(day: DayViewData | null): string | null {
  if (day === null) return null;
  const { localDate, tasks, eventsToday, nextUp } = day;
  return JSON.stringify({ localDate, tasks, eventsToday, nextUp });
}

function stopIssuing(issuedFor: number): void {
  if (issuedFor === generation) issuingStopped = true;
}

async function issueToken(issuedFor: number): Promise<string | null> {
  try {
    return (await callAction(api.deviceApi.issueToken, {})).deviceToken;
  } catch (e) {
    if (!(e instanceof BackendError) || e.status !== REFUSED_FOR_THIS_PAIRING) throw e;
    stopIssuing(issuedFor);
    tokenRefused = issuedFor === generation;
    logger.info('Widget', 'No widget token for this pairing; asking again after the next pairing');
    return null;
  }
}

export function widgetTokenRefused(): boolean {
  return tokenRefused;
}

export async function ensureWidgetToken(): Promise<boolean> {
  const issuedFor = generation;
  const stillCurrent = (): boolean => issuedFor === generation;
  const storedSite = await SunnyWidget.storedSiteUrl();
  if (!stillCurrent()) return false;
  if (storedSite === CONVEX_SITE_URL) return true;
  if (issuingStopped) return false;
  const deviceToken = await issueToken(issuedFor);
  if (deviceToken === null || !stillCurrent()) return false;
  const store = SunnyWidget.setCredentials(deviceToken, CONVEX_SITE_URL);
  storing = store.catch(() => undefined);
  try {
    await store;
  } catch (e) {
    stopIssuing(issuedFor);
    logger.error('Widget', `Could not store the widget credentials: ${errorMessage(e)}`);
    return false;
  }
  return stillCurrent();
}

async function syncOnce(): Promise<void> {
  if (!(await ensureWidgetToken())) return;
  const result = await SunnyWidget.flushPresses();
  if (result === 'unauthorized' && (await ensureWidgetToken())) await SunnyWidget.flushPresses();
  await SunnyWidget.syncSurfaces();
}

export function syncWidget(): Promise<void> {
  syncRun ??= syncOnce()
    .catch((e: unknown) => logger.warning('Widget', `Widget sync failed: ${errorMessage(e)}`))
    .finally(() => {
      syncRun = null;
    });
  return syncRun;
}

export async function clearWidget(): Promise<void> {
  generation += 1;
  issuingStopped = false;
  tokenRefused = false;
  await storing;
  await SunnyWidget.clearCredentials();
}

export function syncSurfaces(): Promise<void> {
  return SunnyWidget.syncSurfaces().catch((e: unknown) =>
    logger.warning('Widget', `Lock Screen sync failed: ${errorMessage(e)}`),
  );
}
