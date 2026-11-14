// sunny_app/src/display/__tests__/DisplayParts.test.tsx
//
// Purpose: Render tests for where the voice card goes on the Now screen (NowBody): in the Next
// up column beside a waiting task, so the task Done confirms stays in view; across the whole
// body when nothing is waiting; and the Next up card as before without a voice card. Also the
// Now card's tab: "Now", "Still to do" when overdue, "Later" with AM or PM when snoozed
// (also at midnight and noon). And the Today rows (TodayBody): a missed row is grey with no
// check and no "Now" tag and reads "Earlier today, not marked done"; done, plain and Now rows
// are as before.
//
// Last modified: 2026-11-13

import { describe, expect, it } from '@jest/globals';
import React from 'react';
import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NowBody, TodayBody, tabText } from '../DisplayParts';
import type { NextItem, NowCard, TodayRow } from '../model';
import { ink } from '../theme';
import type { VoiceCard } from '../voiceModel';

const TASK: NowCard = {
  kind: 'task',
  task: {
    instanceId: 't1',
    displayLabel: 'Morning pills',
    type: 'medication',
    pillDescription: null,
    scheduledTime: '08:00',
  },
  overdue: false,
  steps: null,
} as unknown as NowCard;

const CLEAR: NowCard = { kind: 'clear', allDone: false };

const NEXT: NextItem = { title: 'Sarah visits', when: '2:00', icon: 'calendar', initial: 'S' };

const ANSWER: VoiceCard = { kind: 'answer', tab: 'Sunny', text: 'Sarah is coming at 2.' };

/**
 * purpose: Render NowBody and collect its text.
 * @param card: (NowCard) The Now card.
 * @param voice: (VoiceCard | null) The voice card.
 * @return: (string) Every text node joined with "|".
 */
function textOf(card: NowCard, voice: VoiceCard | null): string {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<NowBody card={card} step={0} next={NEXT} voice={voice} />);
  });
  return renderer.root
    .findAll((node) => typeof node.props.children === 'string')
    .map((node) => node.props.children as string)
    .join('|');
}

describe('NowBody', () => {
  it('puts the voice card in place of Next up beside a waiting task', () => {
    const text = textOf(TASK, ANSWER);
    expect(text).toContain('Morning pills');
    expect(text).toContain('Sarah is coming at 2.');
    expect(text).not.toContain('Next up');
  });

  it('gives the voice card the whole body when nothing is waiting', () => {
    const text = textOf(CLEAR, ANSWER);
    expect(text).toContain('Sarah is coming at 2.');
    expect(text).not.toContain('Nothing to do right now.');
    expect(text).not.toContain('Next up');
  });

  it('shows the listening prompt', () => {
    const listening: VoiceCard = {
      kind: 'prompt',
      tab: 'Talk',
      icon: 'mic',
      title: 'Listening',
      detail: 'Ask your question.',
    };
    expect(textOf(CLEAR, listening)).toContain('Listening|Ask your question.');
  });

  it('shows Next up without a voice card', () => {
    expect(textOf(TASK, null)).toContain('Next up');
  });
});

describe('tabText', () => {
  /**
   * purpose: A one-step task card at 8:00.
   * @param overdue: (boolean) The family has been alerted.
   * @param snoozed: (boolean) The senior said "not yet".
   * @param scheduledTime: (string) Its local "HH:MM" time; 08:00 by default.
   * @return: (NowCard) The card.
   */
  const card = (overdue: boolean, snoozed: boolean, scheduledTime = '08:00'): NowCard =>
    ({
      kind: 'task',
      task: { scheduledTime, displayLabel: 'Morning pills', snoozed },
      overdue,
      steps: null,
    }) as unknown as NowCard;

  it('reads Now or Still to do with the plain clock time', () => {
    expect(tabText(card(false, false))).toBe('Now  ·  8:00');
    expect(tabText(card(true, false))).toBe('Still to do  ·  8:00');
    expect(tabText(card(false, false, '12:30'))).toBe('Now  ·  12:30');
  });

  it('reads Later with AM or PM for a snoozed task, overdue or not', () => {
    expect(tabText(card(false, true))).toBe('Later  ·  8:00 AM');
    expect(tabText(card(true, true))).toBe('Later  ·  8:00 AM');
    expect(tabText(card(false, true, '12:30'))).toBe('Later  ·  12:30 PM');
  });

  it('writes midnight and noon as 12:00 AM and 12:00 PM', () => {
    expect(tabText(card(false, true, '00:00'))).toBe('Later  ·  12:00 AM');
    expect(tabText(card(false, true, '12:00'))).toBe('Later  ·  12:00 PM');
  });

  it('reads Now alone when nothing is waiting', () => {
    expect(tabText(CLEAR)).toBe('Now');
  });
});

describe('TodayBody row marks', () => {
  /**
   * purpose: Render one Today row with the given mark and read what it draws.
   * @param mark: (TodayRow['mark']) The row's mark.
   * @return: (object) The row's accessibility value, time and label colors, symbol names and
   *          the text drawn.
   */
  function renderRow(mark: TodayRow['mark']) {
    const row: TodayRow = { key: 'r1', time: '8:00', label: 'Breakfast pills', mark };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<TodayBody rows={[row]} hidden={0} />);
    });
    const line = renderer.root.findByProps({ accessibilityLabel: '8:00, Breakfast pills' });
    const colorOf = (text: string): unknown => {
      const node = line.findAllByType(Text).find((t) => t.props.children === text);
      return (StyleSheet.flatten(node!.props.style) as { color: unknown }).color;
    };
    return {
      value: (line.props.accessibilityValue as { text: string } | undefined)?.text,
      timeColor: colorOf('8:00'),
      labelColor: colorOf('Breakfast pills'),
      symbols: line.findAllByType(SymbolView).map((s) => s.props.name as string),
      texts: line.findAllByType(Text).map((t) => t.props.children as unknown),
    };
  }

  it('draws a missed row in grey with no check and no Now tag', () => {
    const view = renderRow('missed');
    expect(view.timeColor).toBe(ink.grey);
    expect(view.labelColor).toBe(ink.grey);
    expect(view.symbols).toEqual([]);
    expect(view.texts).not.toContain('Now');
  });

  it('reads a missed row as earlier today, not marked done', () => {
    const view = renderRow('missed');
    expect(view.value).toBe('Earlier today, not marked done');
    expect(view.value).not.toMatch(/missed|late|overdue|forgot|failed/i);
  });

  it('keeps a done row grey with a check', () => {
    const view = renderRow('done');
    expect(view.labelColor).toBe(ink.grey);
    expect(view.symbols).toEqual(['checkmark']);
    expect(view.value).toBe('Done');
  });

  it('keeps a plain row in ink with nothing added', () => {
    const view = renderRow('none');
    expect(view.timeColor).toBe(ink.ink);
    expect(view.labelColor).toBe(ink.ink);
    expect(view.symbols).toEqual([]);
    expect(view.value).toBeUndefined();
  });

  it('keeps the Now row tagged', () => {
    const view = renderRow('now');
    expect(view.texts).toContain('Now');
    expect(view.value).toBe('Now');
  });
});
