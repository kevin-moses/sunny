// sunny_app/src/caregiver/__tests__/haptics.test.ts
//
// Purpose: Unit tests for the haptics wrapper: tapHaptic and undoHaptic call the right
// expo-haptics functions, and neither throws when the module fails to load, when a call throws,
// or when a call rejects.
//
// Last modified: 2026-11-01

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { resetHapticsForTests, tapHaptic, undoHaptic } from '../haptics';

const mockImpact = jest.fn<(style: unknown) => Promise<void>>();
const mockSelection = jest.fn<() => Promise<void>>();

jest.mock('../../logging/logger', () => ({ logger: { debug: jest.fn() } }));

jest.mock('expo-haptics', () => ({
  impactAsync: (style: unknown) => mockImpact(style),
  selectionAsync: () => mockSelection(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

describe('haptics wrapper', () => {
  beforeEach(() => {
    resetHapticsForTests();
    mockImpact.mockReset().mockResolvedValue(undefined);
    mockSelection.mockReset().mockResolvedValue(undefined);
  });

  it('tapHaptic fires a light impact', () => {
    tapHaptic();
    expect(mockImpact).toHaveBeenCalledWith('light');
    expect(mockSelection).not.toHaveBeenCalled();
  });

  it('undoHaptic fires a selection click', () => {
    undoHaptic();
    expect(mockSelection).toHaveBeenCalledTimes(1);
    expect(mockImpact).not.toHaveBeenCalled();
  });

  it('does not throw when a call throws synchronously', () => {
    mockImpact.mockImplementation(() => {
      throw new Error('native module missing');
    });
    expect(() => tapHaptic()).not.toThrow();
  });

  it('does not throw or leak a rejection when a call rejects', async () => {
    mockSelection.mockRejectedValue(new Error('no haptic engine'));
    expect(() => undoHaptic()).not.toThrow();
    await Promise.resolve();
    expect(mockSelection).toHaveBeenCalledTimes(1);
  });
});

describe('haptics wrapper when the module cannot be required', () => {
  it('does not throw from either function', () => {
    jest.resetModules();
    jest.doMock('expo-haptics', () => {
      throw new Error('Cannot find native module ExpoHaptics');
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const isolated = require('../haptics') as typeof import('../haptics');
    expect(() => isolated.tapHaptic()).not.toThrow();
    expect(() => isolated.undoHaptic()).not.toThrow();
  });
});
