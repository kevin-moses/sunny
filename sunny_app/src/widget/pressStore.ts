import SunnyWidget from '../../modules/sunny-widget';
import { isLoggedPress, PressNotSaved, type PressStore, type SeenLog } from '../day/pressLog';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import {
  ensureWidgetToken,
  flushWidgetPresses,
  syncSurfaces,
  syncWidget,
  type WidgetToken,
} from './widgetSync';

type SendRun = 'flush' | 'sync';

let seen: SeenLog = { presses: [], at: 0 };
let sending: Promise<void> | null = null;
let folded: SendRun | null = null;
let reads = 0;
const listeners = new Set<() => void>();

export async function readPressLog(): Promise<void> {
  reads += 1;
  const read = reads;
  let raw: unknown;
  try {
    raw = await SunnyWidget.pressLog();
  } catch (e) {
    logger.warning('PressLog', `Could not read the press log: ${errorMessage(e)}`);
    return;
  }
  if (read !== reads) return;
  const next = Array.isArray(raw) ? raw.filter(isLoggedPress) : [];
  if (JSON.stringify(next) === JSON.stringify(seen.presses)) return;
  seen = { presses: next, at: Date.now() };
  listeners.forEach((listener) => listener());
}

function send(run: SendRun): Promise<void> {
  if (sending !== null) {
    folded = folded === 'sync' || run === 'sync' ? 'sync' : 'flush';
    return sending;
  }
  sending = (run === 'sync' ? syncWidget() : flushWidgetPresses())
    .finally(readPressLog)
    .finally(() => {
      sending = null;
      const next = folded;
      folded = null;
      if (next !== null) void send(next);
    });
  return sending;
}

export function sendPresses(): Promise<void> {
  return send('sync');
}

export function resendPresses(): Promise<void> {
  return send('flush');
}

export function showOnSurfaces(): Promise<void> {
  return syncSurfaces().finally(readPressLog);
}

async function tokenForPress(): Promise<WidgetToken> {
  try {
    return await ensureWidgetToken();
  } catch (e) {
    logger.warning('PressLog', `Could not get a device token for a press: ${errorMessage(e)}`);
    return 'unavailable';
  }
}

async function storePress(instanceId: string, step: number): Promise<void> {
  let status = await SunnyWidget.pressDone(instanceId, step);
  if (status === 'noCredentials') {
    const token = await tokenForPress();
    if (token === 'refused') throw new PressNotSaved('press', 'noCredentials');
    if (token === 'unavailable') throw new PressNotSaved('press', 'notSaved');
    status = await SunnyWidget.pressDone(instanceId, step);
  }
  if (status === 'noCredentials' || status === 'notSaved') {
    throw new PressNotSaved('press', 'notSaved');
  }
  await readPressLog();
  void sendPresses();
}

async function storeUndo(pressId: string): Promise<void> {
  const status = await SunnyWidget.pressUndo(pressId);
  if (status !== 'stored') throw new PressNotSaved('undo', status);
  await readPressLog();
  void sendPresses();
}

export const phonePresses: PressStore = {
  subscribe: (listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  getSeen: () => seen,
  storePress,
  storeUndo,
};
