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

export type WidgetToken = 'ready' | 'refused' | 'unavailable';

type TokenIssuing = 'open' | 'refused' | 'storeFailed';

let issuing: TokenIssuing = 'open';
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

function stopIssuing(issuedFor: number, why: Exclude<TokenIssuing, 'open'>): void {
  if (issuedFor === generation) issuing = why;
}

async function issueToken(issuedFor: number): Promise<string | null> {
  try {
    return (await callAction(api.deviceApi.issueToken, {})).deviceToken;
  } catch (e) {
    if (!(e instanceof BackendError) || e.status !== REFUSED_FOR_THIS_PAIRING) throw e;
    stopIssuing(issuedFor, 'refused');
    logger.info('Widget', 'No widget token for this pairing; asking again after the next pairing');
    return null;
  }
}

export async function ensureWidgetToken(): Promise<WidgetToken> {
  const issuedFor = generation;
  const stillCurrent = (): boolean => issuedFor === generation;
  const storedSite = await SunnyWidget.storedSiteUrl();
  if (!stillCurrent()) return 'unavailable';
  if (storedSite === CONVEX_SITE_URL) return 'ready';
  if (issuing === 'refused') return 'refused';
  if (issuing === 'storeFailed') return 'unavailable';
  const deviceToken = await issueToken(issuedFor);
  if (!stillCurrent()) return 'unavailable';
  if (deviceToken === null) return 'refused';
  const store = SunnyWidget.setCredentials(deviceToken, CONVEX_SITE_URL);
  storing = store.catch(() => undefined);
  try {
    await store;
  } catch (e) {
    stopIssuing(issuedFor, 'storeFailed');
    logger.error('Widget', `Could not store the widget credentials: ${errorMessage(e)}`);
    return 'unavailable';
  }
  return stillCurrent() ? 'ready' : 'unavailable';
}

async function flushWithToken(): Promise<boolean> {
  if ((await ensureWidgetToken()) !== 'ready') return false;
  const result = await SunnyWidget.flushPresses();
  if (result === 'unauthorized' && (await ensureWidgetToken()) === 'ready') {
    await SunnyWidget.flushPresses();
  }
  return true;
}

function logFailure(run: Promise<unknown>): Promise<void> {
  return run.then(
    () => undefined,
    (e: unknown) => logger.warning('Widget', `Widget sync failed: ${errorMessage(e)}`),
  );
}

export function flushWidgetPresses(): Promise<void> {
  return logFailure(flushWithToken());
}

export function syncWidget(): Promise<void> {
  return logFailure(
    flushWithToken().then(async (hadToken) => {
      if (hadToken) await SunnyWidget.syncSurfaces();
    }),
  );
}

export async function clearWidget(): Promise<void> {
  generation += 1;
  issuing = 'open';
  await storing;
  await SunnyWidget.clearCredentials();
}

export function syncSurfaces(): Promise<void> {
  return SunnyWidget.syncSurfaces().catch((e: unknown) =>
    logger.warning('Widget', `Lock Screen sync failed: ${errorMessage(e)}`),
  );
}
