import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { LoggedPress } from '../../day/pressLog';

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const mockNative = {
  pressLog: jest.fn<() => Promise<unknown>>(),
  pressDone: jest.fn<AnyMock>(),
  pressUndo: jest.fn<AnyMock>(),
};
const mockEnsureToken = jest.fn<() => Promise<'ready' | 'refused' | 'unavailable'>>();
const mockSyncWidget = jest.fn<() => Promise<void>>();
const mockFlushWidgetPresses = jest.fn<() => Promise<void>>();
const mockSyncSurfaces = jest.fn<() => Promise<void>>();
const mockLogger = { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() };

jest.mock('../../../modules/sunny-widget', () => ({ __esModule: true, default: mockNative }));

jest.mock('../widgetSync', () => ({
  ensureWidgetToken: () => mockEnsureToken(),
  syncWidget: () => mockSyncWidget(),
  flushWidgetPresses: () => mockFlushWidgetPresses(),
  syncSurfaces: () => mockSyncSurfaces(),
}));

jest.mock('../../logging/logger', () => ({ logger: mockLogger }));

function loadModule(): typeof import('../pressStore') {
  let loaded: typeof import('../pressStore') | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof import('../pressStore')>('../pressStore');
  });
  if (loaded === undefined) throw new Error('pressStore did not load');
  return loaded;
}

const NOW = Date.parse('2026-11-09T09:41:00Z');
const PRESS: LoggedPress = { pressId: 'P1', instanceId: 'inst1', step: 0, pressedAt: NOW };

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockNative.pressLog.mockResolvedValue([]);
  mockNative.pressDone.mockResolvedValue('stored');
  mockNative.pressUndo.mockResolvedValue('stored');
  mockEnsureToken.mockResolvedValue('ready');
  mockSyncWidget.mockResolvedValue(undefined);
  mockFlushWidgetPresses.mockResolvedValue(undefined);
  mockSyncSurfaces.mockResolvedValue(undefined);
});

describe('readPressLog', () => {
  it('shows the native log with the time it was read, and tells who is listening', async () => {
    const { phonePresses, readPressLog } = loadModule();
    const heard = jest.fn();
    phonePresses.subscribe(heard);
    mockNative.pressLog.mockResolvedValue([PRESS, { junk: true }, null]);
    await readPressLog();
    expect(phonePresses.getSeen()).toEqual({ presses: [PRESS], at: NOW });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('keeps the same snapshot when nothing changed', async () => {
    const { phonePresses, readPressLog } = loadModule();
    mockNative.pressLog.mockResolvedValue([PRESS]);
    await readPressLog();
    const first = phonePresses.getSeen();
    const heard = jest.fn();
    phonePresses.subscribe(heard);
    jest.setSystemTime(NOW + 60_000);
    await readPressLog();
    expect(phonePresses.getSeen()).toBe(first);
    expect(heard).not.toHaveBeenCalled();
  });

  it('lets only the latest of two overlapping reads decide', async () => {
    const { phonePresses, readPressLog } = loadModule();
    let finishOld!: (log: unknown) => void;
    mockNative.pressLog
      .mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)))
      .mockResolvedValueOnce([PRESS]);
    const old = readPressLog();
    await readPressLog();
    finishOld([]);
    await old;
    expect(phonePresses.getSeen().presses).toEqual([PRESS]);
  });

  it('keeps what it had and logs when the native side cannot be read', async () => {
    const { phonePresses, readPressLog } = loadModule();
    mockNative.pressLog.mockResolvedValueOnce([PRESS]);
    await readPressLog();
    mockNative.pressLog.mockRejectedValueOnce(new Error('native'));
    await readPressLog();
    expect(phonePresses.getSeen().presses).toEqual([PRESS]);
    expect(mockLogger.warning).toHaveBeenCalledTimes(1);
  });
});

describe('storing a press', () => {
  it('stores it natively, reads the log before it answers, then sends', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressLog.mockResolvedValue([PRESS]);
    await phonePresses.storePress('inst1', 0);
    expect(mockNative.pressDone).toHaveBeenCalledWith('inst1', 0);
    expect(phonePresses.getSeen().presses).toEqual([PRESS]);
    expect(mockSyncWidget).toHaveBeenCalledTimes(1);
    expect(mockNative.pressDone.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncWidget.mock.invocationCallOrder[0]!,
    );
  });

  it('counts a press that could only be sent at once as saved', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressDone.mockResolvedValue('sent');
    await expect(phonePresses.storePress('inst1', 0)).resolves.toBeUndefined();
  });

  it('asks for a device token once when the phone has none, then stores the press', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressDone.mockResolvedValueOnce('noCredentials').mockResolvedValueOnce('stored');
    await phonePresses.storePress('inst1', 0);
    expect(mockEnsureToken).toHaveBeenCalledTimes(1);
    expect(mockNative.pressDone).toHaveBeenCalledTimes(2);
  });

  it('refuses the press as unpaired when the server refuses this pairing a token', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressDone.mockResolvedValue('noCredentials');
    mockEnsureToken.mockResolvedValue('refused');
    await expect(phonePresses.storePress('inst1', 0)).rejects.toMatchObject({
      name: 'PressNotSaved',
      noCredentials: true,
    });
    expect(mockNative.pressDone).toHaveBeenCalledTimes(1);
    expect(mockSyncWidget).not.toHaveBeenCalled();
  });

  it('refuses the press as not saved when no token can be had now', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressDone.mockResolvedValue('noCredentials');
    mockEnsureToken.mockResolvedValue('unavailable');
    await expect(phonePresses.storePress('inst1', 0)).rejects.toMatchObject({
      name: 'PressNotSaved',
      noCredentials: false,
    });
    expect(mockNative.pressDone).toHaveBeenCalledTimes(1);
  });

  it('refuses the press as not saved when the second try finds no token either', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressDone.mockResolvedValue('noCredentials');
    await expect(phonePresses.storePress('inst1', 0)).rejects.toMatchObject({
      name: 'PressNotSaved',
      noCredentials: false,
    });
    expect(mockNative.pressDone).toHaveBeenCalledTimes(2);
  });

  it('refuses the press as not saved when a token could not be asked for', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressDone.mockResolvedValue('noCredentials');
    mockEnsureToken.mockRejectedValue(new Error('offline'));
    await expect(phonePresses.storePress('inst1', 0)).rejects.toMatchObject({
      name: 'PressNotSaved',
      noCredentials: false,
    });
    expect(mockLogger.warning).toHaveBeenCalledTimes(1);
  });

  it('refuses a press that could be neither stored nor sent', async () => {
    const { phonePresses } = loadModule();
    mockNative.pressDone.mockResolvedValue('notSaved');
    await expect(phonePresses.storePress('inst1', 0)).rejects.toMatchObject({
      noCredentials: false,
    });
    expect(mockEnsureToken).not.toHaveBeenCalled();
  });
});

describe('storing an undo', () => {
  it('stores it for the press it names, reads the log, then sends', async () => {
    const { phonePresses } = loadModule();
    const undone = { ...PRESS, undo: { undoneAt: NOW } };
    mockNative.pressLog.mockResolvedValue([undone]);
    await phonePresses.storeUndo('P1');
    expect(mockNative.pressUndo).toHaveBeenCalledWith('P1');
    expect(phonePresses.getSeen().presses).toEqual([undone]);
    expect(mockSyncWidget).toHaveBeenCalledTimes(1);
  });

  it.each(['notSaved', 'noCredentials'])('refuses when the native side says %s', async (status) => {
    const { phonePresses } = loadModule();
    mockNative.pressUndo.mockResolvedValue(status);
    await expect(phonePresses.storeUndo('P1')).rejects.toMatchObject({ name: 'PressNotSaved' });
    expect(mockSyncWidget).not.toHaveBeenCalled();
  });
});

describe('sendPresses and resendPresses', () => {
  it('reads the log once the sync is over', async () => {
    const { sendPresses } = loadModule();
    await sendPresses();
    expect(mockSyncWidget.mock.invocationCallOrder[0]).toBeLessThan(
      mockNative.pressLog.mock.invocationCallOrder[0]!,
    );
  });

  it('resends with a flush only, then reads the log', async () => {
    const { resendPresses } = loadModule();
    await resendPresses();
    expect(mockFlushWidgetPresses).toHaveBeenCalledTimes(1);
    expect(mockSyncWidget).not.toHaveBeenCalled();
    expect(mockFlushWidgetPresses.mock.invocationCallOrder[0]).toBeLessThan(
      mockNative.pressLog.mock.invocationCallOrder[0]!,
    );
  });

  it('folds requests made during a run into one more run', async () => {
    const { sendPresses } = loadModule();
    let finish!: () => void;
    mockSyncWidget.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const first = sendPresses();
    void sendPresses();
    void sendPresses();
    expect(mockSyncWidget).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await settle();
    expect(mockSyncWidget).toHaveBeenCalledTimes(2);
    await settle();
    expect(mockSyncWidget).toHaveBeenCalledTimes(2);
  });

  it('shares one guard: a resend during a sync waits and becomes one flush', async () => {
    const { resendPresses, sendPresses } = loadModule();
    let finish!: () => void;
    mockSyncWidget.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const first = sendPresses();
    void resendPresses();
    void resendPresses();
    expect(mockFlushWidgetPresses).not.toHaveBeenCalled();
    finish();
    await first;
    await settle();
    expect(mockSyncWidget).toHaveBeenCalledTimes(1);
    expect(mockFlushWidgetPresses).toHaveBeenCalledTimes(1);
  });

  it('makes the folded run a full sync when any folded request asked for one', async () => {
    const { resendPresses, sendPresses } = loadModule();
    let finish!: () => void;
    mockFlushWidgetPresses.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const first = resendPresses();
    void resendPresses();
    void sendPresses();
    void resendPresses();
    finish();
    await first;
    await settle();
    expect(mockFlushWidgetPresses).toHaveBeenCalledTimes(1);
    expect(mockSyncWidget).toHaveBeenCalledTimes(1);
  });

  it('reads the log even when the sync fails', async () => {
    const { sendPresses } = loadModule();
    mockSyncWidget.mockRejectedValueOnce(new Error('sync'));
    await expect(sendPresses()).rejects.toThrow('sync');
    expect(mockNative.pressLog).toHaveBeenCalledTimes(1);
  });
});

describe('showOnSurfaces', () => {
  it('syncs the widget and the Lock Screen, then reads the log', async () => {
    const { showOnSurfaces } = loadModule();
    await showOnSurfaces();
    expect(mockSyncSurfaces).toHaveBeenCalledTimes(1);
    expect(mockNative.pressLog).toHaveBeenCalledTimes(1);
  });
});
