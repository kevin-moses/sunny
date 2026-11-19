import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { applyPending, overlayEntries } from '../../day/pendingEntries';
import type { PendingConfirm, PressedEntry } from '../../day/pendingEntries';
import { makeTask } from '../../testing/dayFixtures';
import { readUnsentPresses, useUnsentWidgetPresses, widgetPressMirror } from '../sharedPresses';
import { syncSurfaces } from '../widgetSync';

type BridgeCall = (...args: unknown[]) => Promise<void>;

const mockBridge = {
  unsentPresses: jest.fn<() => unknown>(),
  markPressed: jest.fn<BridgeCall>(),
  answerPress: jest.fn<BridgeCall>(),
  withdrawPress: jest.fn<BridgeCall>(),
  syncSurfaces: jest.fn<BridgeCall>(),
};
const mockWarning = jest.fn();

jest.mock('../../../modules/sunny-widget', () => ({
  __esModule: true,
  default: {
    unsentPresses: () => mockBridge.unsentPresses(),
    markPressed: (...args: unknown[]) => mockBridge.markPressed(...args),
    answerPress: (...args: unknown[]) => mockBridge.answerPress(...args),
    withdrawPress: (...args: unknown[]) => mockBridge.withdrawPress(...args),
    syncSurfaces: () => mockBridge.syncSurfaces(),
  },
}));

jest.mock('../../backend/api', () => ({ callAction: jest.fn() }));
jest.mock('../../backend/convexApi', () => ({ api: { deviceApi: { issueToken: 'issueToken' } } }));
jest.mock('../../config', () => ({ CONVEX_SITE_URL: 'https://example.convex.site' }));

jest.mock('../../logging/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warning: (...args: unknown[]) => mockWarning(...args),
    error: jest.fn(),
  },
}));

const PRESS_ID = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';

const APP_PRESS: PendingConfirm = {
  instanceId: 'pills' as PendingConfirm['instanceId'],
  label: 'Morning pills',
  pressedAt: 1_795_098_660_000,
  pressId: 'b7d2c1e4-5a6f-4c3b-9e8d-7f6a5b4c3d2e',
  step: 1,
};

let seen: readonly PressedEntry[] = [];
let renderer: ReactTestRenderer | null = null;

function record(presses: readonly PressedEntry[]): void {
  seen = presses;
}

function Probe() {
  const presses = useUnsentWidgetPresses();
  useEffect(() => record(presses), [presses]);
  return null;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBridge.unsentPresses.mockReturnValue([]);
  mockBridge.markPressed.mockResolvedValue(undefined);
  mockBridge.answerPress.mockResolvedValue(undefined);
  mockBridge.withdrawPress.mockResolvedValue(undefined);
  mockBridge.syncSurfaces.mockResolvedValue(undefined);
  readUnsentPresses();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('useUnsentWidgetPresses', () => {
  it("gives the app the widget's and the Lock Screen's unsent presses", () => {
    mockBridge.unsentPresses.mockReturnValue([
      { id: PRESS_ID, instanceId: 'pills', step: 0, pressedAt: 1_795_098_600_000 },
    ]);
    act(() => {
      renderer = create(<Probe />);
    });
    expect(seen).toEqual([
      { instanceId: 'pills', pressedAt: 1_795_098_600_000, pressId: PRESS_ID, step: 0 },
    ]);
  });

  it('shows a press the widget sent as gone after the next read', () => {
    mockBridge.unsentPresses.mockReturnValue([
      { id: PRESS_ID, instanceId: 'pills', step: 0, pressedAt: 1_795_098_600_000 },
    ]);
    act(() => {
      renderer = create(<Probe />);
    });
    mockBridge.unsentPresses.mockReturnValue([]);
    act(() => readUnsentPresses());
    expect(seen).toEqual([]);
  });

  it('drops a Lock Screen press once it was sent, so a task reopened later shows as due', async () => {
    mockBridge.unsentPresses.mockReturnValue([
      { id: PRESS_ID, instanceId: 'pills', step: 0, pressedAt: 1_795_098_600_000 },
    ]);
    act(() => {
      renderer = create(<Probe />);
    });
    expect(seen).toHaveLength(1);
    mockBridge.unsentPresses.mockReturnValue([]);
    act(() => syncSurfaces());
    await settle();
    const reopened = makeTask({
      instanceId: 'pills' as PendingConfirm['instanceId'],
      state: 'due',
    });
    const [shown] = applyPending([reopened], overlayEntries([], seen));
    expect(shown?.state).toBe('due');
  });

  it('leaves out anything the native side sends that is not a press', () => {
    mockBridge.unsentPresses.mockReturnValue([
      { id: PRESS_ID, instanceId: 'pills', step: 0.5, pressedAt: 1 },
      { id: 7, instanceId: 'pills', step: 0, pressedAt: 1 },
      null,
      { id: PRESS_ID, instanceId: 'tea', step: 2, pressedAt: 5 },
    ]);
    act(() => {
      renderer = create(<Probe />);
    });
    expect(seen.map((press) => press.instanceId)).toEqual(['tea']);
  });

  it('keeps the last good list when the native read throws', () => {
    mockBridge.unsentPresses.mockReturnValue([
      { id: PRESS_ID, instanceId: 'pills', step: 0, pressedAt: 1 },
    ]);
    act(() => {
      renderer = create(<Probe />);
    });
    mockBridge.unsentPresses.mockImplementation(() => {
      throw new Error('no app group');
    });
    act(() => readUnsentPresses());
    expect(seen).toHaveLength(1);
    expect(mockWarning).toHaveBeenCalledTimes(1);
  });
});

describe('widgetPressMirror', () => {
  it('marks an app press on the widget with its id, task, step and press time', async () => {
    widgetPressMirror.pressed(APP_PRESS);
    await settle();
    expect(mockBridge.markPressed).toHaveBeenCalledWith(
      APP_PRESS.pressId,
      'pills',
      1,
      APP_PRESS.pressedAt,
    );
  });

  it('tells the widget when the server answered the press and when it was undone', async () => {
    widgetPressMirror.answered(APP_PRESS);
    widgetPressMirror.withdrawn(APP_PRESS.pressId);
    await settle();
    expect(mockBridge.answerPress).toHaveBeenCalledWith(APP_PRESS.pressId);
    expect(mockBridge.withdrawPress).toHaveBeenCalledWith(APP_PRESS.pressId);
  });

  it('logs a native failure instead of throwing into the queue', async () => {
    mockBridge.markPressed.mockRejectedValue(new Error('disk full'));
    expect(() => widgetPressMirror.pressed(APP_PRESS)).not.toThrow();
    await settle();
    expect(mockWarning).toHaveBeenCalledTimes(1);
  });
});
