import SunnyWidget from '../../modules/sunny-widget';
import { callAction } from '../backend/api';
import { api } from '../backend/convexApi';
import type { SessionDecision } from '../backend/pairing';
import { CONVEX_SITE_URL } from '../config';
import type { DayViewData } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { readUnsentPresses } from './sharedPresses';

type WidgetHolder = 'seniorPhone' | 'none' | 'undecided';

let storeFailed = false;
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

export async function ensureWidgetToken(): Promise<boolean> {
  if (SunnyWidget.storedSiteUrl() === CONVEX_SITE_URL) return true;
  if (storeFailed) return false;
  const issuedFor = generation;
  const { deviceToken } = await callAction(api.deviceApi.issueToken, {});
  if (issuedFor !== generation) return false;
  const store = SunnyWidget.setCredentials(deviceToken, CONVEX_SITE_URL);
  storing = store.catch(() => undefined);
  try {
    await store;
  } catch (e) {
    storeFailed = issuedFor === generation;
    logger.error('Widget', `Could not store the widget credentials: ${errorMessage(e)}`);
    return false;
  }
  return issuedFor === generation;
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
      readUnsentPresses();
    });
  return syncRun;
}

export async function clearWidget(): Promise<void> {
  generation += 1;
  storeFailed = false;
  await storing;
  await SunnyWidget.clearCredentials();
}

export function syncSurfaces(): void {
  SunnyWidget.syncSurfaces()
    .catch((e: unknown) => logger.warning('Widget', `Lock Screen sync failed: ${errorMessage(e)}`))
    .finally(readUnsentPresses);
}
