// sunny_app/src/display/__tests__/DisplayParts.test.tsx
//
// Purpose: Render tests for where the voice card goes on the Now screen (NowBody): in the Next
// up column beside a waiting task, so the task Done confirms stays in view; across the whole
// body when nothing is waiting; and the Next up card as before without a voice card.
//
// Last modified: 2026-11-09

import { describe, expect, it } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NowBody } from '../DisplayParts';
import type { NextItem, NowCard } from '../model';
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
