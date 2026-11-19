import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React, { type ReactElement } from 'react';
import { Dimensions, StyleSheet, type TextStyle, type ViewStyle } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { buildAgenda } from '../../day/format';
import type { DayTask, DayViewData, EventOccurrence } from '../../day/types';
import type { UndoLineData } from '../../day/useDoneAction';
import { dayRows, screenMode, type ScreenMode } from '../model';
import { DayList, DoneSlot, HeadlineSlot, OfflineNote, TagRow } from '../PhoneParts';
import { cappedScale, layout, paper, roles, shadows } from '../theme';

jest.mock('expo-symbols', () => ({
  SymbolView: ({ name, tintColor }: { name: string; tintColor?: string }) => {
    const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
    return <MockText style={{ color: tintColor }}>{`symbol:${name}`}</MockText>;
  },
}));

const NOW = Date.parse('2026-11-09T10:00:00Z');
const renderers: ReactTestRenderer[] = [];

afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
});

function render(element: ReactElement): ReactTestInstance {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  renderers.push(renderer);
  return renderer.root;
}

function strings(root: ReactTestInstance): string[] {
  return root.findAll((n) => (n.type as unknown) === 'Text').map((n) => String(n.props.children));
}

function words(root: ReactTestInstance): string[] {
  return strings(root).filter((s) => !s.startsWith('symbol:'));
}

function symbols(root: ReactTestInstance): string[] {
  return strings(root)
    .filter((s) => s.startsWith('symbol:'))
    .map((s) => s.slice('symbol:'.length));
}

function textOf(root: ReactTestInstance, text: string): TextStyle {
  const node = root.find((n) => (n.type as unknown) === 'Text' && n.props.children === text);
  return StyleSheet.flatten(node.props.style) as TextStyle;
}

function scaleOf(root: ReactTestInstance, text: string): number {
  const node = root.find((n) => (n.type as unknown) === 'Text' && n.props.children === text);
  return node.props.maxFontSizeMultiplier as number;
}

function buttons(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    (n) => typeof n.props.style === 'function' && n.props.accessibilityRole === 'button',
  );
}

function keyStyle(key: ReactTestInstance, pressed = false): ViewStyle {
  const style = key.props.style as (state: { pressed: boolean }) => unknown;
  return StyleSheet.flatten(style({ pressed }) as ViewStyle);
}

function hostView(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((n) => (n.type as unknown) === 'View' && n.props.accessibilityLabel === label);
}

function outer(root: ReactTestInstance): ReactTestInstance {
  return root.findAll((n) => (n.type as unknown) === 'View')[0]!;
}

function styleOf(node: ReactTestInstance): ViewStyle {
  return StyleSheet.flatten(node.props.style) as ViewStyle;
}

function allColors(root: ReactTestInstance): unknown[] {
  return root
    .findAll(() => true)
    .flatMap((n) => {
      if (typeof n.props.style === 'function') return [];
      const style = StyleSheet.flatten(n.props.style) as (ViewStyle & TextStyle) | undefined;
      if (style === undefined) return [];
      return [
        style.backgroundColor,
        style.color,
        style.borderColor,
        JSON.stringify(style.boxShadow),
      ];
    });
}

function task(overrides: Partial<DayTask> = {}): DayTask {
  return {
    instanceId: 'pills',
    displayLabel: 'Morning pills',
    screenSentence: 'Take your morning pills.',
    pillDescription: 'the small white ones',
    checklistItems: [],
    step: null,
    scheduledTime: '09:30',
    state: 'due',
    confirmable: true,
    ...overrides,
  } as unknown as DayTask;
}

const STEPPED = task({
  checklistItems: ['Fill a glass', 'Take the small white ones with water.', 'Rinse the glass'],
  step: { index: 1, count: 3, text: 'Take the small white ones with water.' },
});

const EARLY = task({
  instanceId: 'walk' as never,
  displayLabel: 'Morning walk',
  screenSentence: 'Go for your morning walk.',
  pillDescription: null,
  scheduledTime: '10:15',
  state: 'upcoming',
});

const UNDO: UndoLineData = {
  label: 'Morning pills',
  text: 'Morning pills done.',
  pressedAt: Date.parse('2026-11-09T09:41:00Z'),
};

function mode(input: Partial<Parameters<typeof screenMode>[0]>): ScreenMode {
  return screenMode({
    task: null,
    message: null,
    undo: null,
    next: null,
    timezone: 'UTC',
    ...input,
  });
}

describe('TagRow', () => {
  it('shows the yellow "Now" tag for a due task, and no time beside it', () => {
    const root = render(<TagRow mode={mode({ task: task() })} />);
    expect(words(root)).toEqual(['Now']);
    const tag = root.find(
      (n) => (n.type as unknown) === 'View' && styleOf(n).backgroundColor === paper.now,
    );
    expect(styleOf(tag)).toMatchObject({
      borderRadius: 4,
      paddingVertical: 2,
      paddingHorizontal: 8,
    });
    expect(textOf(root, 'Now')).toMatchObject({ ...roles.tag.style, color: paper.ink });
  });

  it('adds the step counter on a step task', () => {
    const root = render(<TagRow mode={mode({ task: STEPPED })} />);
    expect(words(root)).toEqual(['Now', 'Step 2 of 3']);
    expect(textOf(root, 'Step 2 of 3')).toMatchObject({ ...roles.step.style, marginLeft: 'auto' });
  });

  it('says when the early task is coming up, with no tag and no yellow', () => {
    const root = render(<TagRow mode={mode({ task: EARLY })} />);
    expect(words(root)).toEqual(['Coming up at 10:15 AM']);
    expect(textOf(root, 'Coming up at 10:15 AM')).toMatchObject({ ...roles.tag.style });
    expect(allColors(root)).not.toContain(paper.now);
  });

  it('keeps its height and is empty after Done, with nothing due and while loading', () => {
    for (const shown of [mode({ undo: UNDO }), mode({ next: 'Next: Lunch at 12:30 PM' }), null]) {
      const root = render(<TagRow mode={shown} />);
      expect(words(root)).toEqual([]);
      expect(styleOf(outer(root))).toMatchObject({
        height: layout.tagRow,
        alignItems: 'flex-end',
      });
    }
  });
});

describe('HeadlineSlot', () => {
  const onUndo = jest.fn();

  it('shows the screen sentence and the pill description', () => {
    const root = render(<HeadlineSlot mode={mode({ task: task() })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Take your morning pills.', 'the small white ones']);
    expect(textOf(root, 'Take your morning pills.')).toMatchObject({ ...roles.headline.style });
    expect(textOf(root, 'the small white ones')).toMatchObject({ ...roles.detail.style });
  });

  it('falls back to the display label and leaves the detail out when there is none', () => {
    const plain = task({ screenSentence: null, pillDescription: null });
    const root = render(<HeadlineSlot mode={mode({ task: plain })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Morning pills']);
  });

  it('shows the step text with the task label under it', () => {
    const root = render(<HeadlineSlot mode={mode({ task: STEPPED })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Take the small white ones with water.', 'Morning pills']);
  });

  it('shrinks a long sentence to fit the fixed slot instead of cutting it off', () => {
    const root = render(<HeadlineSlot mode={mode({ task: task() })} onUndo={onUndo} />);
    const sentence = root.find(
      (n) => (n.type as unknown) === 'Text' && n.props.children === 'Take your morning pills.',
    );
    expect(sentence.props.adjustsFontSizeToFit).toBe(true);
    expect(sentence.props.numberOfLines).toBeUndefined();
    expect(sentence.props.lineBreakStrategyIOS).toBe('standard');
    expect(textOf(root, 'Take your morning pills.').flexShrink).toBe(1);
    expect(styleOf(outer(root)).height).toBe(layout.headline);
  });

  it('says there is nothing to do when nothing is due', () => {
    const root = render(<HeadlineSlot mode={mode({})} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Nothing to do right now.']);
    expect(textOf(root, 'Nothing to do right now.')).toMatchObject({ ...roles.headline.style });
  });

  it('after Done shows the undo text and an Undo key that takes the press back', () => {
    const undo = jest.fn();
    const root = render(<HeadlineSlot mode={mode({ undo: UNDO })} onUndo={undo} />);
    expect(words(root)).toEqual(['Morning pills done.', 'Undo']);
    expect(textOf(root, 'Morning pills done.')).toMatchObject({ ...roles.undoLine.style });
    const [key] = buttons(root);
    expect(key!.props.accessibilityLabel).toBe('Undo Morning pills done');
    expect(symbols(root)).toEqual(['arrow.uturn.backward']);
    expect(keyStyle(key!)).toMatchObject({
      width: 150,
      height: 58,
      borderRadius: 18,
      borderWidth: 3,
      borderColor: paper.ink,
      backgroundColor: paper.paper,
      boxShadow: shadows.undo,
    });
    expect(keyStyle(key!, true).backgroundColor).toBe(paper.panel);
    act(() => key!.props.onPress());
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('keeps the Undo key under another task that is now on the Done key', () => {
    const next = task({
      instanceId: 'b' as never,
      displayLabel: 'Evening pills',
      screenSentence: null,
      pillDescription: null,
    });
    const root = render(<HeadlineSlot mode={mode({ task: next, undo: UNDO })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Evening pills', 'Undo', 'Morning pills done.']);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual([
      'Undo Morning pills done',
    ]);
  });

  it('shows a message in place of the detail line', () => {
    const root = render(
      <HeadlineSlot
        mode={mode({ task: task(), message: 'Please press Done again.' })}
        onUndo={onUndo}
      />,
    );
    expect(words(root)).toEqual(['Take your morning pills.', 'Please press Done again.']);
  });

  it('shows a message on its own in the headline style', () => {
    const root = render(<HeadlineSlot mode={mode({ message: 'Waiting.' })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Waiting.']);
    expect(textOf(root, 'Waiting.')).toMatchObject({ ...roles.headline.style });
  });
});

describe('DoneSlot', () => {
  it('is an ink key with the yellow glow that pulls in under a finger', () => {
    const onDone = jest.fn();
    const root = render(<DoneSlot mode={mode({ task: task() })} onDone={onDone} />);
    const [key] = buttons(root);
    expect(key!.props.accessibilityLabel).toBe('Done: Morning pills');
    expect(words(root)).toEqual(['Done']);
    expect(symbols(root)).toEqual(['checkmark']);
    expect(textOf(root, 'Done')).toMatchObject({ ...roles.doneKey.style, color: paper.paper });
    const resting = keyStyle(key!);
    expect(resting).toMatchObject({
      height: layout.key,
      borderRadius: layout.keyRadius,
      backgroundColor: paper.ink,
      boxShadow: shadows.done,
    });
    expect(shadows.done[0]).toEqual({
      offsetX: 0,
      offsetY: 14,
      blurRadius: 30,
      spreadDistance: 2,
      color: '#FABF39',
    });
    const pressed = keyStyle(key!, true);
    expect(pressed.boxShadow).toBe(shadows.donePressed);
    expect(shadows.donePressed[0]).toMatchObject({
      offsetY: 4,
      blurRadius: 12,
      color: '#FABF39E6',
    });
    expect(pressed.backgroundColor).toBe(paper.ink);
    act(() => key!.props.onPress());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(styleOf(outer(root)).height).toBe(layout.doneSlot);
  });

  it('reads the step on a step task', () => {
    const root = render(<DoneSlot mode={mode({ task: STEPPED })} onDone={() => {}} />);
    expect(buttons(root)[0]!.props.accessibilityLabel).toBe(
      'Done: Morning pills, step 2 of 3, Take the small white ones with water.',
    );
  });

  it('is a paper key with an ink outline and a plain shadow when early, with no yellow', () => {
    const root = render(<DoneSlot mode={mode({ task: EARLY })} onDone={() => {}} />);
    const [key] = buttons(root);
    expect(key!.props.accessibilityLabel).toBe('Done early: Morning walk, coming up at 10:15 am');
    expect(words(root)).toEqual(['Done early']);
    expect(textOf(root, 'Done early')).toMatchObject({ ...roles.earlyKey.style, color: paper.ink });
    expect(keyStyle(key!)).toMatchObject({
      backgroundColor: paper.paper,
      borderWidth: 3,
      borderColor: paper.ink,
      boxShadow: shadows.early,
    });
    expect(keyStyle(key!, true).backgroundColor).toBe(paper.panel);
    expect(allColors(root)).not.toContain(paper.now);
    expect(JSON.stringify(shadows.early)).not.toContain('FABF39');
  });

  it('after Done is a flat panel with the time of the press, not a key', () => {
    const root = render(<DoneSlot mode={mode({ undo: UNDO })} onDone={() => {}} />);
    expect(buttons(root)).toHaveLength(0);
    expect(words(root)).toEqual(['Noted at 9:41 AM']);
    expect(symbols(root)).toEqual(['checkmark']);
    const panel = hostView(root, 'Noted at 9:41 AM');
    expect(styleOf(panel)).toMatchObject({ backgroundColor: paper.panel, height: layout.key });
    expect(styleOf(panel).boxShadow).toBeUndefined();
    expect(textOf(root, 'Noted at 9:41 AM')).toMatchObject({ ...roles.keyStatus.style });
  });

  it('with nothing due is a flat panel naming the next item', () => {
    const root = render(
      <DoneSlot mode={mode({ next: 'Next: Lunch at 12:30 PM' })} onDone={() => {}} />,
    );
    expect(buttons(root)).toHaveLength(0);
    expect(words(root)).toEqual(['Next: Lunch at 12:30 PM']);
    expect(symbols(root)).toEqual([]);
    expect(styleOf(hostView(root, 'Next: Lunch at 12:30 PM'))).toMatchObject({
      backgroundColor: paper.panel,
      paddingHorizontal: 24,
    });
    expect(textOf(root, 'Next: Lunch at 12:30 PM')).toMatchObject({
      ...roles.next.style,
      textAlign: 'center',
    });
  });

  it('stays empty but keeps its height with nothing next and for a message', () => {
    for (const shown of [mode({}), mode({ message: 'Waiting.' })]) {
      const root = render(<DoneSlot mode={shown} onDone={() => {}} />);
      expect(strings(root)).toEqual([]);
      expect(styleOf(outer(root)).height).toBe(layout.doneSlot);
    }
  });
});

describe('DayList', () => {
  function event(overrides: Partial<EventOccurrence> = {}): EventOccurrence {
    return {
      eventId: 'visit',
      label: 'Sarah visits',
      localDate: '2026-11-09',
      startTime: '14:00',
      startsAt: Date.parse('2026-11-09T14:00:00Z'),
      endsAt: null,
      ...overrides,
    } as unknown as EventOccurrence;
  }

  function list(tasks: DayTask[], shown: DayTask | null, events: EventOccurrence[] = []) {
    const day = { tasks, eventsToday: events } as unknown as DayViewData;
    return render(<DayList rows={dayRows(buildAgenda(day), shown, NOW)} />);
  }

  function row(root: ReactTestInstance, label: string) {
    const node = hostView(root, label);
    return {
      node,
      style: styleOf(node),
      value: (node.props.accessibilityValue as { text: string }).text,
      words: words(node),
      symbols: symbols(node),
    };
  }

  it('lays a plain row out as mark slot, a fixed time column and the label', () => {
    const scale = cappedScale(Dimensions.get('window').fontScale, roles.rowTime);
    const root = list(
      [task({ state: 'upcoming', scheduledTime: '12:30', displayLabel: 'Lunch' })],
      null,
    );
    const plain = row(root, '12:30 PM, Lunch');
    expect(plain.style).toMatchObject({
      minHeight: layout.row * scale,
      paddingLeft: 10,
      paddingRight: 8,
      gap: 8,
      flexDirection: 'row',
    });
    expect(plain.style.backgroundColor).toBeUndefined();
    expect(plain.symbols).toEqual([]);
    expect(textOf(plain.node, '12:30 PM')).toMatchObject({
      ...roles.rowTime.style,
      width: 98 * scale,
      color: paper.ink,
    });
    expect(textOf(plain.node, 'Lunch')).toMatchObject({
      ...roles.rowLabel.style,
      color: paper.ink,
    });
    expect(plain.value).toBe('');
  });

  it('fills the due row yellow with extra-bold time and label', () => {
    const due = task();
    const now = row(list([due], due), '9:30 AM, Morning pills');
    expect(now.style).toMatchObject({ backgroundColor: paper.now, borderRadius: 6 });
    expect(textOf(now.node, '9:30 AM')).toMatchObject({ ...roles.rowStrong.style });
    expect(textOf(now.node, 'Morning pills')).toMatchObject({ ...roles.rowStrong.style });
    expect(now.value).toBe('Due now');
  });

  it('makes the early row extra-bold with no yellow', () => {
    const early = row(list([EARLY], EARLY), '10:15 AM, Morning walk');
    expect(early.style.backgroundColor).toBeUndefined();
    expect(textOf(early.node, 'Morning walk')).toMatchObject({
      ...roles.rowStrong.style,
      color: paper.ink,
    });
    expect(early.value).toBe('Coming up');
  });

  it('greys a done row with a grey check and no strikethrough', () => {
    const done = row(list([task({ state: 'confirmed' })], null), '9:30 AM, Morning pills');
    expect(done.symbols).toEqual(['checkmark']);
    expect(textOf(done.node, 'symbol:checkmark').color).toBe(paper.grey);
    expect(textOf(done.node, '9:30 AM').color).toBe(paper.grey);
    expect(textOf(done.node, 'Morning pills')).toMatchObject({
      ...roles.rowLabel.style,
      color: paper.grey,
    });
    expect(textOf(done.node, 'Morning pills').textDecorationLine).toBeUndefined();
    expect(done.value).toBe('Done');
  });

  it('greys a missed row with no mark and no word for it', () => {
    const missed = row(list([task({ state: 'missed' })], null), '9:30 AM, Morning pills');
    expect(missed.symbols).toEqual([]);
    expect(missed.words).toEqual(['9:30 AM', 'Morning pills']);
    expect(textOf(missed.node, 'Morning pills').color).toBe(paper.grey);
    expect(textOf(missed.node, '9:30 AM').color).toBe(paper.grey);
    expect(missed.value).not.toMatch(/missed|late|overdue|forgot|failed/i);
  });

  it('marks an event with an ink calendar and greys a past one', () => {
    const root = list([], null, [
      event({
        eventId: 'walk' as never,
        label: 'Walk',
        startTime: '08:00',
        startsAt: Date.parse('2026-11-09T08:00:00Z'),
      }),
      event(),
    ]);
    const past = row(root, '8:00 AM, Walk');
    const coming = row(root, '2:00 PM, Sarah visits');
    expect(coming.symbols).toEqual(['calendar']);
    expect(textOf(coming.node, 'symbol:calendar').color).toBe(paper.ink);
    expect(textOf(coming.node, 'Sarah visits').color).toBe(paper.ink);
    expect(textOf(past.node, 'symbol:calendar').color).toBe(paper.grey);
    expect(textOf(past.node, 'Walk').color).toBe(paper.grey);
    expect(past.value).toBe('Earlier today');
  });

  it('has no section title and scrolls on its own', () => {
    const root = list([task({ state: 'upcoming' })], null);
    expect(words(root)).toEqual(['9:30 AM', 'Morning pills']);
    const scroll = root.find((n) => (n.type as unknown) === 'RCTScrollView');
    expect(styleOf(scroll).flex).toBe(1);
  });
});

describe('text size caps', () => {
  it('caps every role so the fixed slots hold at large text sizes', () => {
    const root = render(<HeadlineSlot mode={mode({ task: task() })} onUndo={() => {}} />);
    expect(scaleOf(root, 'Take your morning pills.')).toBe(roles.headline.maxScale);
    for (const role of Object.values(roles)) {
      expect(role.maxScale).toBeGreaterThanOrEqual(1.2);
      expect(role.maxScale).toBeLessThanOrEqual(1.4);
    }
  });

  it('grows the list rows and the time column with the text size, up to the cap', () => {
    expect(Dimensions.get('window').fontScale).toBe(2);
    expect(cappedScale(2, roles.rowTime)).toBe(1.3);
    expect(cappedScale(0.9, roles.rowTime)).toBe(0.9);
  });

  it('keeps the tag row text inside its 38 point row at its cap', () => {
    const tagLine = roles.tag.style.lineHeight * roles.tag.maxScale + 4;
    expect(tagLine).toBeLessThanOrEqual(layout.tagRow);
  });
});

describe('OfflineNote', () => {
  it('says not connected in grey with the wifi symbol at the top right of the column', () => {
    const root = render(<OfflineNote />);
    expect(words(root)).toEqual(['Not connected']);
    expect(symbols(root)).toEqual(['wifi.slash']);
    expect(textOf(root, 'Not connected')).toMatchObject({
      ...roles.offline.style,
      color: paper.grey,
    });
    expect(styleOf(hostView(root, 'Not connected'))).toMatchObject({
      position: 'absolute',
      top: 8,
      right: 24,
      gap: 6,
    });
  });
});
