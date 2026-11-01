// sunny_app/src/caregiver/__tests__/haptics.test.ts
//
// Purpose: Unit tests for the haptics wrapper: tapHaptic and undoHaptic call the right
// expo-haptics functions, and a rejected call does not surface as an unhandled rejection.
//
// Last modified: 2026-11-01

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Haptics from 'expo-haptics';

import { tapHaptic, undoHaptic } from '../haptics';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

const mockImpact = Haptics.impactAsync as jest.MockedFunction<typeof Haptics.impactAsync>;
const mockSelection = Haptics.selectionAsync as jest.MockedFunction<typeof Haptics.selectionAsync>;

describe('haptics wrapper', () => {
  beforeEach(() => {
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

  it('swallows a rejected call', async () => {
    mockImpact.mockRejectedValue(new Error('no haptic engine'));
    mockSelection.mockRejectedValue(new Error('no haptic engine'));
    expect(() => tapHaptic()).not.toThrow();
    expect(() => undoHaptic()).not.toThrow();
    await Promise.resolve();
  });
});
