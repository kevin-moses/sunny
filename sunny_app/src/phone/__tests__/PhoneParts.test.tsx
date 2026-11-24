import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React, { type ReactElement } from 'react';
import { Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { buildAgenda } from '../../day/format';
import type { DayTask, EventOccurrence } from '../../day/types';
import type { UndoLineData } from '../../day/useDoneAction';
import { instanceIdOf, eventIdOf, makeDay, makeEvent, makeTask } from '../../testing/dayFixtures';
import { dayRows, screenMode, type ModeInput, type ScreenMode } from '../model';
import { DayList, DoneSlot, HeadlineSlot, OfflineNote, TagRow } from '../PhoneParts';
import { layout, roles } from '../theme';

jest.mock('expo-symbols', () => ({
  SymbolView: ({ name }: { name: string }) => {
    const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
    return <MockText>{`symbol:${name}`}</MockText>;
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

function texts(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAllByType(Text);
}

function strings(root: ReactTestInstance): string[] {
  return texts(root).map((n) => String(n.props.children));
}

function words(root: ReactTestInstance): string[] {
  return strings(root).filter((s) => !s.startsWith('symbol:'));
}

function symbols(root: ReactTestInstance): string[] {
  return strings(root)
    .filter((s) => s.startsWith('symbol:'))
    .map((s) => s.slice('symbol:'.length));
}

function buttons(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    (n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button',
  );
}

function spoken(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((n) => n.type === View && n.props.accessibilityLabel === label);
}

const STEPPED = makeTask({
  checklistItems: ['Fill a glass', 'Take the small white ones with water.', 'Rinse the glass'],
  step: { index: 1, count: 3, text: 'Take the small white ones with water.' },
});

const EARLY = makeTask({
  instanceId: instanceIdOf('walk'),
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

function mode(input: Partial<ModeInput>): ScreenMode {
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
  it('says Now for a due task, with no time beside it', () => {
    expect(words(render(<TagRow mode={mode({ task: makeTask() })} />))).toEqual(['Now']);
  });

  it('adds the step counter on a step task', () => {
    expect(words(render(<TagRow mode={mode({ task: STEPPED })} />))).toEqual([
      'Now',
      'Step 2 of 3',
    ]);
  });

  it('says when the early task is coming up instead of Now', () => {
    expect(words(render(<TagRow mode={mode({ task: EARLY })} />))).toEqual([
      'Coming up at 10:15 AM',
    ]);
  });

  it('is empty after Done, with nothing due and while loading', () => {
    for (const shown of [mode({ undo: UNDO }), mode({ next: 'Next: Lunch at 12:30 PM' }), null]) {
      expect(strings(render(<TagRow mode={shown} />))).toEqual([]);
    }
  });
});

describe('HeadlineSlot', () => {
  const onUndo = jest.fn();

  it('shows the screen sentence and the pill description', () => {
    const root = render(<HeadlineSlot mode={mode({ task: makeTask() })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Take your morning pills.', 'the small white ones']);
  });

  it('falls back to the display label and leaves the detail out when there is none', () => {
    const plain = makeTask({ screenSentence: null, pillDescription: null });
    const root = render(<HeadlineSlot mode={mode({ task: plain })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Morning pills']);
  });

  it('shows the step text with the task label under it', () => {
    const root = render(<HeadlineSlot mode={mode({ task: STEPPED })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Take the small white ones with water.', 'Morning pills']);
  });

  it('shrinks a long sentence to fit instead of cutting it off', () => {
    const root = render(<HeadlineSlot mode={mode({ task: makeTask() })} onUndo={onUndo} />);
    const sentence = texts(root).find((n) => n.props.children === 'Take your morning pills.');
    expect(sentence?.props.adjustsFontSizeToFit).toBe(true);
    expect(sentence?.props.numberOfLines).toBeUndefined();
  });

  it('says there is nothing to do when nothing is due', () => {
    const root = render(<HeadlineSlot mode={mode({})} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Nothing to do right now.']);
  });

  it('after Done shows the undo text and an Undo key that takes the press back', () => {
    const undo = jest.fn();
    const root = render(<HeadlineSlot mode={mode({ undo: UNDO })} onUndo={undo} />);
    expect(words(root)).toEqual(['Morning pills done.', 'Undo']);
    expect(symbols(root)).toEqual(['arrow.uturn.backward']);
    const [key] = buttons(root);
    expect(key?.props.accessibilityLabel).toBe('Undo Morning pills done');
    act(() => key?.props.onPress());
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('keeps the Undo key under the next step that is now on the Done key', () => {
    const root = render(
      <HeadlineSlot mode={mode({ task: STEPPED, undo: UNDO })} onUndo={onUndo} />,
    );
    expect(words(root)).toEqual([
      'Take the small white ones with water.',
      'Morning pills',
      'Undo',
      'Morning pills done.',
    ]);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual([
      'Undo Morning pills done',
    ]);
  });

  it('shows a message in place of the detail line', () => {
    const root = render(
      <HeadlineSlot
        mode={mode({ task: makeTask(), message: 'Please press Done again.' })}
        onUndo={onUndo}
      />,
    );
    expect(words(root)).toEqual(['Take your morning pills.', 'Please press Done again.']);
  });

  it('shows a message on its own when nothing else is up', () => {
    const root = render(<HeadlineSlot mode={mode({ message: 'Waiting.' })} onUndo={onUndo} />);
    expect(words(root)).toEqual(['Waiting.']);
  });
});

describe('DoneSlot', () => {
  it('is a Done key that VoiceOver reads with the task and that takes the press', () => {
    const onDone = jest.fn();
    const root = render(<DoneSlot mode={mode({ task: makeTask() })} onDone={onDone} />);
    expect(words(root)).toEqual(['Done']);
    expect(symbols(root)).toEqual(['checkmark']);
    const [key] = buttons(root);
    expect(key?.props.accessibilityLabel).toBe('Done: Morning pills');
    act(() => key?.props.onPress());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('reads the step on a step task', () => {
    const root = render(<DoneSlot mode={mode({ task: STEPPED })} onDone={() => {}} />);
    expect(buttons(root)[0]?.props.accessibilityLabel).toBe(
      'Done: Morning pills, step 2 of 3, Take the small white ones with water.',
    );
  });

  it('says Done early on a task inside its early hour, and reads when it is due', () => {
    const root = render(<DoneSlot mode={mode({ task: EARLY })} onDone={() => {}} />);
    expect(words(root)).toEqual(['Done early']);
    expect(buttons(root)[0]?.props.accessibilityLabel).toBe(
      'Done early: Morning walk, coming up at 10:15 am',
    );
  });

  it("after Done says when the press was noted, in the household's zone, and offers no key", () => {
    const root = render(
      <DoneSlot mode={mode({ undo: UNDO, timezone: 'America/New_York' })} onDone={() => {}} />,
    );
    expect(buttons(root)).toHaveLength(0);
    expect(words(root)).toEqual(['Noted at 4:41 AM']);
    expect(spoken(root, 'Noted at 4:41 AM')).toBeDefined();
  });

  it('with nothing due names the next item, which VoiceOver reads, and offers no key', () => {
    const root = render(
      <DoneSlot mode={mode({ next: 'Next: Lunch at 12:30 PM' })} onDone={() => {}} />,
    );
    expect(buttons(root)).toHaveLength(0);
    expect(words(root)).toEqual(['Next: Lunch at 12:30 PM']);
    expect(spoken(root, 'Next: Lunch at 12:30 PM')).toBeDefined();
  });

  it('is empty with nothing next and for a message', () => {
    for (const shown of [mode({}), mode({ message: 'Waiting.' })]) {
      expect(strings(render(<DoneSlot mode={shown} onDone={() => {}} />))).toEqual([]);
    }
  });
});

describe('DayList', () => {
  function list(tasks: DayTask[], shown: DayTask | null, events: EventOccurrence[] = []) {
    const day = makeDay({ tasks, eventsToday: events });
    return render(<DayList rows={dayRows(buildAgenda(day), shown, NOW)} />);
  }

  function row(root: ReactTestInstance, label: string) {
    const node = spoken(root, label);
    return {
      value: (node.props.accessibilityValue as { text: string }).text,
      words: words(node),
      symbols: symbols(node),
    };
  }

  it('reads a plain row as its time and label, with no mark and nothing more', () => {
    const lunch = makeTask({ state: 'upcoming', scheduledTime: '12:30', displayLabel: 'Lunch' });
    expect(row(list([lunch], null), '12:30 PM, Lunch')).toEqual({
      value: '',
      words: ['12:30 PM', 'Lunch'],
      symbols: [],
    });
  });

  it('reads the due row on the Done key as due now', () => {
    const due = makeTask();
    expect(row(list([due], due), '9:30 AM, Morning pills').value).toBe('Due now');
  });

  it('reads the early row on the Done key as coming up', () => {
    expect(row(list([EARLY], EARLY), '10:15 AM, Morning walk').value).toBe('Coming up');
  });

  it('marks a done row with a check and reads it as done', () => {
    const done = row(list([makeTask({ state: 'confirmed' })], null), '9:30 AM, Morning pills');
    expect(done.symbols).toEqual(['checkmark']);
    expect(done.value).toBe('Done');
  });

  it('gives a missed row no mark and no alarming word', () => {
    const missed = row(list([makeTask({ state: 'missed' })], null), '9:30 AM, Morning pills');
    expect(missed.symbols).toEqual([]);
    expect(missed.words).toEqual(['9:30 AM', 'Morning pills']);
    expect(missed.value).not.toMatch(/missed|late|overdue|forgot|failed/i);
  });

  it('marks an event with a calendar and reads a past one as earlier today', () => {
    const root = list([], null, [
      makeEvent({
        eventId: eventIdOf('walk'),
        label: 'Walk',
        startTime: '08:00',
        startsAt: Date.parse('2026-11-09T08:00:00Z'),
      }),
      makeEvent(),
    ]);
    expect(row(root, '2:00 PM, Sarah visits')).toEqual({
      value: '',
      words: ['2:00 PM', 'Sarah visits'],
      symbols: ['calendar'],
    });
    expect(row(root, '8:00 AM, Walk').value).toBe('Earlier today');
  });

  it('has no section title', () => {
    expect(words(list([makeTask({ state: 'upcoming' })], null))).toEqual([
      '9:30 AM',
      'Morning pills',
    ]);
  });
});

describe('text size caps', () => {
  it('caps every text in every slot so the fixed slots hold at large text sizes', () => {
    const shown = [
      mode({ task: STEPPED, undo: UNDO }),
      mode({ task: EARLY }),
      mode({ undo: UNDO }),
      mode({ next: 'Next: Lunch at 12:30 PM' }),
    ];
    for (const current of shown) {
      const root = render(
        <>
          <TagRow mode={current} />
          <HeadlineSlot mode={current} onUndo={() => {}} />
          <DoneSlot mode={current} onDone={() => {}} />
        </>,
      );
      const shownText = texts(root).filter((n) => !String(n.props.children).startsWith('symbol:'));
      expect(shownText.length).toBeGreaterThan(1);
      for (const text of shownText) {
        expect(text.props.maxFontSizeMultiplier).toBeLessThanOrEqual(1.4);
      }
    }
  });

  it('keeps the tag row text inside its row at its cap', () => {
    const tagLine = roles.tag.style.lineHeight * roles.tag.maxScale + 4;
    expect(tagLine).toBeLessThanOrEqual(layout.tagRow);
  });
});

describe('OfflineNote', () => {
  it('says not connected, to VoiceOver as well', () => {
    const root = render(<OfflineNote />);
    expect(words(root)).toEqual(['Not connected']);
    expect(symbols(root)).toEqual(['wifi.slash']);
    expect(spoken(root, 'Not connected')).toBeDefined();
  });
});
