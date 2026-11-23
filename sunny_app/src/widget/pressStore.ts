import SunnyWidget from '../../modules/sunny-widget';
import { isLoggedPress, PressNotSaved, type PressStore, type SeenLog } from '../day/pressLog';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { ensureWidgetToken, syncSurfaces, syncWidget, widgetTokenRefused } from './widgetSync';

let seen: SeenLog = { presses: [], at: 0 };
let sending: Promise<void> | null = null;
let sendAgain = false;
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

export function sendPresses(): Promise<void> {
  if (sending !== null) {
    sendAgain = true;
    return sending;
  }
  sending = syncWidget()
    .finally(readPressLog)
    .finally(() => {
      sending = null;
      if (!sendAgain) return;
      sendAgain = false;
      void sendPresses();
    });
  return sending;
}

export function showOnSurfaces(): Promise<void> {
  return syncSurfaces().finally(readPressLog);
}

async function tokenIssued(): Promise<boolean> {
  try {
    return await ensureWidgetToken();
  } catch (e) {
    logger.warning('PressLog', `Could not get a device token for a press: ${errorMessage(e)}`);
    return false;
  }
}

async function storePress(instanceId: string, step: number): Promise<void> {
  let status = await SunnyWidget.pressDone(instanceId, step);
  if (status === 'noCredentials' && (await tokenIssued())) {
    status = await SunnyWidget.pressDone(instanceId, step);
  }
  if (status === 'noCredentials') {
    throw new PressNotSaved('press', widgetTokenRefused() ? 'noCredentials' : 'notSaved');
  }
  if (status === 'notSaved') throw new PressNotSaved('press', status);
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
