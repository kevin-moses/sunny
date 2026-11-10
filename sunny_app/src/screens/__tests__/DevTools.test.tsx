// sunny_app/src/screens/__tests__/DevTools.test.tsx
//
// Purpose: Tests for the DEV pill (DevTools), rendered for real with the sheet it opens, the
// theme and the safe area replaced by stand-ins: on the home display a plain tap does nothing and only a hold of
// DISPLAY_DEV_HOLD_MS opens the sheet; on other devices a tap opens it.
//
// Last modified: 2026-11-09

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Modal } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { DISPLAY_DEV_HOLD_MS, DevTools } from '../DevTools';

jest.mock('../DevSettingsSheet', () => ({ DevSettingsSheet: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../theme/ThemeProvider', () => ({
  useTheme: () => ({ accentColor: '#000000' }),
}));

const renderers: ReactTestRenderer[] = [];

afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
});

/**
 * purpose: Render the pill.
 * @param display: (boolean) Whether this is the home display.
 * @return: (ReactTestRenderer) The renderer.
 */
function renderPill(display: boolean): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<DevTools display={display} />);
  });
  renderers.push(renderer);
  return renderer;
}

/**
 * purpose: Whether the developer sheet's modal is open.
 * @param renderer: (ReactTestRenderer) The renderer.
 * @return: (boolean) True when it is visible.
 */
function sheetOpen(renderer: ReactTestRenderer): boolean {
  return renderer.root.findByType(Modal).props.visible === true;
}

/**
 * purpose: The DEV pill as DevTools renders it (the Pressable element with its props).
 * @param renderer: (ReactTestRenderer) The renderer.
 * @return: (ReactTestInstance) The pill.
 */
function pillOf(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findAll(
    (node) =>
      node.props.accessibilityLabel === 'Open developer settings' &&
      node.props.delayLongPress !== undefined,
  )[0]!;
}

describe('DevTools', () => {
  it('needs a long press on the home display; a plain tap does nothing', () => {
    const renderer = renderPill(true);
    const pill = pillOf(renderer);
    expect(pill.props.onPress).toBeUndefined();
    expect(pill.props.delayLongPress).toBe(DISPLAY_DEV_HOLD_MS);
    expect(sheetOpen(renderer)).toBe(false);
    act(() => pill.props.onLongPress());
    expect(sheetOpen(renderer)).toBe(true);
  });

  it('opens with a tap elsewhere', () => {
    const renderer = renderPill(false);
    const pill = pillOf(renderer);
    expect(pill.props.onLongPress).toBeUndefined();
    act(() => pill.props.onPress());
    expect(sheetOpen(renderer)).toBe(true);
  });
});
