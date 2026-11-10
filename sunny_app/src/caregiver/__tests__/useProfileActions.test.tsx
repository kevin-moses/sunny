// sunny_app/src/caregiver/__tests__/useProfileActions.test.tsx
//
// Purpose: Tests for useProfileActions, rendering the real hook with react-test-renderer and a
// mocked callMutation (the network layer): every edited text goes to the right profile mutation
// with the right arguments (null clears an entry's details), adds, confirm, removals and messages
// call their mutations, a running call shows "working" in its slot, success clears the slot, an
// add that finds the same text stored says "Already saved." and one that confirms a senior fact
// says "Confirmed." (both resolve true), an add that finds other text stored resolves false and
// says nothing was saved, a failure shows the server's message and resolves false, a call that
// ends after a newer one in the same slot leaves the newer state alone, and the actions keep
// their identity between renders.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { callMutation } from '../../backend/api';
import type { FieldTarget } from '../aboutFormat';
import { useProfileActions, type ProfileActions } from '../useProfileActions';

jest.mock('../../backend/convex', () => ({ convex: {} }));

jest.mock('../../backend/api', () => ({
  ...jest.requireActual<typeof import('../../backend/api')>('../../backend/api'),
  callMutation: jest.fn(),
}));

const mockCall = callMutation as unknown as jest.Mock<(...a: unknown[]) => Promise<unknown>>;
const HOUSEHOLD = 'h1' as never;
/** Renderers created by a test, unmounted afterwards. */
const mounted: ReactTestRenderer[] = [];

/**
 * purpose: Render the real hook and expose its latest return value.
 * @return: (object) A getter for the current ProfileActions.
 */
function renderActions(): { get: () => ProfileActions } {
  let current!: ProfileActions;
  const Probe = (): null => {
    current = useProfileActions(HOUSEHOLD);
    return null;
  };
  act(() => {
    mounted.push(create(<Probe />));
  });
  return { get: () => current };
}

/**
 * purpose: The name and arguments of the nth callMutation call.
 * @param n: (number) Call index.
 * @return: ([string, unknown]) Function name ("module:function") and arguments.
 */
function callAt(n: number): [string, unknown] {
  const [ref, args] = mockCall.mock.calls[n]!;
  return [getFunctionName(ref as never), args];
}

describe('useProfileActions', () => {
  beforeEach(() => {
    mockCall.mockReset();
    mockCall.mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((renderer) => renderer.unmount());
    });
  });

  it.each<[string, FieldTarget, string | null, string, Record<string, unknown>]>([
    [
      'an entry name',
      { kind: 'entryName', id: 'e1' as never, current: 'A' },
      'Sarah',
      'profile:updateEntry',
      { householdId: 'h1', entryId: 'e1', name: 'Sarah' },
    ],
    [
      'cleared details',
      { kind: 'entryDetails', id: 'e1' as never, current: 'D' },
      null,
      'profile:updateEntry',
      { householdId: 'h1', entryId: 'e1', details: null },
    ],
    [
      'a topic',
      { kind: 'topic', id: 't1' as never, current: 'T' },
      'money',
      'profile:updateTopic',
      { householdId: 'h1', topicId: 't1', topic: 'money' },
    ],
    [
      'guidance',
      { kind: 'guidance', id: 't1' as never, current: 'G' },
      'Say it is paid.',
      'profile:updateTopic',
      { householdId: 'h1', topicId: 't1', guidance: 'Say it is paid.' },
    ],
    [
      'a fact correction',
      { kind: 'fact', id: 'f1' as never, current: 'F' },
      'Likes tea',
      'profile:correctFact',
      { householdId: 'h1', factId: 'f1', fact: 'Likes tea' },
    ],
  ])('saves %s through its mutation', async (_label, target, value, fn, args) => {
    const h = renderActions();
    let ok = false;
    await act(async () => {
      ok = await h.get().saveField(target, value);
    });
    expect(ok).toBe(true);
    expect(callAt(0)).toEqual([fn, args]);
    expect(h.get().states).toEqual({});
  });

  it('adds an entry, topic and fact, confirms, removes and sends', async () => {
    mockCall.mockResolvedValue({ created: true });
    const h = renderActions();
    await act(async () => {
      await h.get().addEntry({ category: 'person', name: 'Sarah', details: 'Daughter' });
      await h.get().addTopic({ topic: 'money', guidance: 'G' });
      await h.get().addFact('Likes tea');
      await h.get().verifyFact('f1' as never);
      await h.get().remove({ kind: 'entry', id: 'e1' as never });
      await h.get().remove({ kind: 'topic', id: 't1' as never });
      await h.get().remove({ kind: 'fact', id: 'f1' as never });
      await h.get().sendMessage('Hello');
    });
    expect(mockCall.mock.calls.map((_c, i) => callAt(i))).toEqual([
      [
        'profile:addEntry',
        { householdId: 'h1', category: 'person', name: 'Sarah', details: 'Daughter' },
      ],
      ['profile:addTopic', { householdId: 'h1', topic: 'money', guidance: 'G' }],
      ['profile:addFact', { householdId: 'h1', fact: 'Likes tea' }],
      ['profile:verifyFact', { householdId: 'h1', factId: 'f1' }],
      ['profile:removeEntry', { householdId: 'h1', entryId: 'e1' }],
      ['profile:removeTopic', { householdId: 'h1', topicId: 't1' }],
      ['profile:removeFact', { householdId: 'h1', factId: 'f1' }],
      ['profile:sendMessage', { householdId: 'h1', body: 'Hello' }],
    ]);
    expect(h.get().states).toEqual({});
  });

  it('shows the slot working while the call runs', async () => {
    let resolve!: (v: unknown) => void;
    mockCall.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const h = renderActions();
    let pending!: Promise<boolean>;
    act(() => {
      pending = h.get().verifyFact('f1' as never);
    });
    expect(h.get().states['fact:f1']).toEqual({ status: 'working' });
    await act(async () => {
      resolve(null);
      await pending;
    });
    expect(h.get().states['fact:f1']).toBeUndefined();
  });

  it('says Already saved when an add finds the same text stored, and lets the form clear', async () => {
    mockCall.mockResolvedValue({ id: 'e1', created: false, same: true, confirmed: false });
    const h = renderActions();
    let ok = false;
    await act(async () => {
      ok = await h.get().addEntry({ category: 'person', name: 'Sarah' });
    });
    expect(ok).toBe(true);
    expect(h.get().states['add:entry']).toEqual({ status: 'notice', message: 'Already saved.' });
  });

  it('says Confirmed when an add confirms a fact the senior had said', async () => {
    mockCall.mockResolvedValue({ id: 'f1', created: false, same: true, confirmed: true });
    const h = renderActions();
    let ok = false;
    await act(async () => {
      ok = await h.get().addFact('Likes tea');
    });
    expect(ok).toBe(true);
    expect(h.get().states['add:fact']).toEqual({ status: 'notice', message: 'Confirmed.' });
  });

  it('resolves false and says nothing was saved when the stored text differs', async () => {
    mockCall.mockResolvedValue({ id: 't1', created: false, same: false, confirmed: false });
    const h = renderActions();
    let ok = true;
    await act(async () => {
      ok = await h.get().addTopic({ topic: 'money', guidance: 'New guidance' });
    });
    expect(ok).toBe(false);
    expect(h.get().states['add:topic']).toEqual({
      status: 'error',
      message: 'Not saved: "money" already has guidance. Tap it in the list above to change it.',
    });
  });

  it("shows the server's message when a call fails and resolves false", async () => {
    mockCall.mockRejectedValue(
      new ConvexError({ code: 'invalid', message: 'Name cannot be blank' }),
    );
    const h = renderActions();
    let ok = true;
    await act(async () => {
      ok = await h.get().saveField({ kind: 'entryName', id: 'e1' as never, current: 'A' }, 'B');
    });
    expect(ok).toBe(false);
    expect(h.get().states['entry:e1']).toEqual({
      status: 'error',
      message: 'Name cannot be blank',
    });
  });

  it('a call that ends after a newer one in the slot leaves the newer state alone', async () => {
    let failFirst!: (e: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    mockCall
      .mockReturnValueOnce(new Promise((_r, reject) => (failFirst = reject)))
      .mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
    const h = renderActions();
    act(() => {
      void h.get().saveField({ kind: 'fact', id: 'f1' as never, current: 'A' }, 'B');
      void h.get().verifyFact('f1' as never);
    });
    await act(async () => {
      failFirst(new Error('boom'));
    });
    expect(h.get().states['fact:f1']).toEqual({ status: 'working' });
    await act(async () => {
      resolveSecond(null);
    });
    expect(h.get().states['fact:f1']).toBeUndefined();
  });

  it('keeps the action functions stable between renders', async () => {
    mockCall.mockResolvedValue({ id: 'f1', created: true, same: true, confirmed: false });
    const h = renderActions();
    const first = h.get();
    await act(async () => {
      await h.get().addFact('Likes tea');
    });
    const second = h.get();
    for (const key of [
      'saveField',
      'addEntry',
      'addTopic',
      'addFact',
      'verifyFact',
      'remove',
      'sendMessage',
    ] as const) {
      expect(second[key]).toBe(first[key]);
    }
  });
});
