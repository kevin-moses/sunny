import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { ActivityIndicator, StyleSheet, type TextStyle, type ViewStyle } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { paper, roles, shadows } from '../../phone/theme';
import { TalkButton } from '../TalkButton';
import type { VoiceConnectionState } from '../voiceContext';

let mockState: VoiceConnectionState = 'disconnected';
const mockConnect = jest.fn<() => Promise<void>>();

jest.mock('../voiceContext', () => ({
  useVoice: () => ({ connect: mockConnect, connectionState: mockState }),
}));

jest.mock('expo-symbols', () => ({
  SymbolView: ({ name }: { name: string }) => {
    const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
    return <MockText>{`symbol:${name}`}</MockText>;
  },
}));

const renderers: ReactTestRenderer[] = [];

beforeEach(() => {
  mockState = 'disconnected';
  mockConnect.mockReset();
  mockConnect.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
});

function render(): ReactTestInstance {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TalkButton />);
  });
  renderers.push(renderer);
  return renderer.root;
}

function key(root: ReactTestInstance): ReactTestInstance {
  return root.find(
    (n) => typeof n.props.style === 'function' && n.props.accessibilityRole === 'button',
  );
}

function keyStyle(root: ReactTestInstance, pressed: boolean): ViewStyle {
  const style = key(root).props.style as (state: { pressed: boolean }) => unknown;
  return StyleSheet.flatten(style({ pressed }) as ViewStyle);
}

function strings(root: ReactTestInstance): string[] {
  return root.findAll((n) => (n.type as unknown) === 'Text').map((n) => String(n.props.children));
}

describe('TalkButton', () => {
  it('rests as the orange key with its glow, a microphone and "Talk to Sunny"', () => {
    const root = render();
    expect(strings(root)).toEqual(['symbol:mic.fill', 'Talk to Sunny']);
    const label = root.find(
      (n) => (n.type as unknown) === 'Text' && n.props.children === 'Talk to Sunny',
    );
    expect(StyleSheet.flatten(label.props.style) as TextStyle).toMatchObject({
      ...roles.talk.style,
    });
    expect(keyStyle(root, false)).toMatchObject({
      height: 64,
      borderRadius: 32,
      backgroundColor: paper.talk,
      gap: 14,
      boxShadow: shadows.talk,
    });
    expect(keyStyle(root, false).borderWidth).toBeUndefined();
    expect(shadows.talk).toEqual([
      { offsetX: 0, offsetY: 10, blurRadius: 24, spreadDistance: 1, color: '#F0620FD9' },
      { offsetX: 0, offsetY: 2, blurRadius: 4, spreadDistance: 0, color: '#F0620F73' },
    ]);
    expect(key(root).props.accessibilityLabel).toBe('Talk to Sunny');
    expect(key(root).props.accessibilityHint).toBe('Double-tap to connect and start speaking');
    expect(key(root).props.accessibilityState).toEqual({ disabled: false, busy: false });
  });

  it('pulls the glow in under a finger without changing colour', () => {
    const pressed = keyStyle(render(), true);
    expect(pressed.boxShadow).toBe(shadows.talkPressed);
    expect(pressed.backgroundColor).toBe(paper.talk);
  });

  it('shows a spinner and "Connecting", and takes no press, while the call connects', () => {
    mockState = 'connecting';
    const root = render();
    expect(strings(root)).toEqual(['Connecting']);
    expect(root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(key(root).props.disabled).toBe(true);
    expect(key(root).props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(keyStyle(root, false).boxShadow).toBe(shadows.talkPressed);
  });

  it('connects once per press and shows Connecting until the call answers', async () => {
    let finish!: () => void;
    mockConnect.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const root = render();
    act(() => key(root).props.onPress());
    act(() => key(root).props.onPress());
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(strings(root)).toEqual(['Connecting']);
    await act(async () => finish());
    expect(strings(root)).toEqual(['symbol:mic.fill', 'Talk to Sunny']);
  });
});
