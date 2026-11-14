// sunny_app/src/components/__tests__/AgendaList.test.tsx
//
// Purpose: Render tests for the phone's agenda (AgendaList), mainly how a missed task (its
// confirmation window closed unconfirmed) is drawn: the label in the dimmed time color, no
// strikethrough, no highlight, the empty circle, and the neutral screen reader value "Earlier
// today, not marked done". Upcoming, due and done rows are checked to be unchanged, and a
// missed task that was later confirmed is drawn as done. The real AgendaList renders; only the
// native symbol view (it records the symbol name) and the theme hook are stubbed.
//
// Last modified: 2026-11-13

import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData } from '../../day/types';
import { colors } from '../../theme/colors';
import { AgendaList } from '../DayComponents';

jest.mock('expo-symbols', () => ({
  SymbolView: ({ name }: { name: string }) => {
    const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
    return <MockText>{`symbol:${name}`}</MockText>;
  },
}));
jest.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ accentColor: '#FA8539' }) }));

/**
 * purpose: Build a task.
 * @param state: (string) The task's state.
 * @return: (DayTask) An 08:00 "Breakfast pills" medication in that state.
 */
function makeTask(state: string): DayTask {
  return {
    instanceId: 't1',
    taskId: 'task1',
    type: 'medication',
    displayLabel: 'Breakfast pills',
    pillDescription: null,
    checklistItems: [],
    scheduledTime: '08:00',
    state,
    carriedOver: false,
  } as unknown as DayTask;
}

/** What one rendered row exposes to the tests. */
interface RowView {
  value: string | undefined;
  label: TextStyle;
  time: TextStyle;
  symbols: string[];
  rowBackground: unknown;
}

/**
 * purpose: Render the agenda for one task and read its row.
 * @param state: (string) The task's state.
 * @return: (RowView) The row's accessibility value, label and time styles, symbols and fill.
 */
function renderRow(state: string): RowView {
  const day = { tasks: [makeTask(state)], eventsToday: [] } as unknown as DayViewData;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<AgendaList items={buildAgenda(day)} />);
  });
  const row = renderer.root.findByProps({ accessibilityLabel: '8:00 AM, Breakfast pills' });
  const texts = row.findAllByType(Text);
  const styleOf = (text: string): TextStyle => {
    const node = texts.find((t) => t.props.children === text);
    return StyleSheet.flatten(node!.props.style) as TextStyle;
  };
  const rowStyle = StyleSheet.flatten(row.props.style) as { backgroundColor: unknown };
  return {
    value: (row.props.accessibilityValue as { text: string }).text,
    label: styleOf('Breakfast pills'),
    time: styleOf('8:00 AM'),
    symbols: texts
      .map((t) => t.props.children as string)
      .filter((c) => typeof c === 'string' && c.startsWith('symbol:')),
    rowBackground: rowStyle.backgroundColor,
  };
}

describe('AgendaList missed task', () => {
  it('dims the label to the time color with no strikethrough and the empty circle', () => {
    const view = renderRow('missed');
    expect(view.label.color).toBe(colors.secondaryText);
    expect(view.label.color).toBe(view.time.color);
    expect(view.label.textDecorationLine).toBe('none');
    expect(view.label.fontWeight).toBe('400');
    expect(view.symbols).toEqual(['symbol:circle']);
  });

  it('is not highlighted and reads as earlier today, not marked done', () => {
    const view = renderRow('missed');
    expect(view.rowBackground).toBe('transparent');
    expect(view.value).toBe('Earlier today, not marked done');
  });

  it('never says missed, late, overdue, forgot or failed to a screen reader', () => {
    expect(renderRow('missed').value).not.toMatch(/missed|late|overdue|forgot|failed/i);
  });

  it('is drawn as done once confirmed or resolved', () => {
    for (const state of ['confirmed', 'resolved']) {
      const view = renderRow(state);
      expect(view.value).toBe('Done');
      expect(view.label.textDecorationLine).toBe('line-through');
      expect(view.label.color).toBe(colors.text);
      expect(view.symbols).toEqual(['symbol:checkmark.circle.fill']);
    }
  });
});

describe('AgendaList other tasks are unchanged', () => {
  it('keeps an upcoming task at full strength with the empty circle', () => {
    const view = renderRow('upcoming');
    expect(view.label.color).toBe(colors.text);
    expect(view.label.textDecorationLine).toBe('none');
    expect(view.value).toBe('');
    expect(view.symbols).toEqual(['symbol:circle']);
  });

  it('keeps a due task bold and highlighted', () => {
    for (const state of ['due', 'escalated']) {
      const view = renderRow(state);
      expect(view.label.color).toBe(colors.text);
      expect(view.label.fontWeight).toBe('700');
      expect(view.value).toBe('Due now');
      expect(view.rowBackground).toBe('#FA853940');
    }
  });
});
