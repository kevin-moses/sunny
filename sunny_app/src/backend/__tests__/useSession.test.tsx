import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionDecision } from '../pairing';
import { useSession } from '../useSession';

interface FakeEntry {
  household: { _id: string };
  role: string | null;
  deviceKind: string | null;
}

interface FakeMine {
  accountKind: 'device' | 'caregiver' | null;
  households: FakeEntry[];
}

interface FakeSession {
  clerk: { isLoaded: boolean; isSignedIn: boolean };
  convex: { isLoading: boolean; isAuthenticated: boolean };
  mine: { status: 'pending' | 'success' | 'error'; data: FakeMine | undefined; error: undefined };
}

const PENDING: FakeSession['mine'] = { status: 'pending', data: undefined, error: undefined };

function signedInLoading(): FakeSession {
  return {
    clerk: { isLoaded: true, isSignedIn: true },
    convex: { isLoading: false, isAuthenticated: true },
    mine: PENDING,
  };
}

const mockSession = signedInLoading();

jest.mock('@clerk/expo', () => ({
  useAuth: () => mockSession.clerk,
}));

jest.mock('convex/react', () => ({
  useConvexAuth: () => mockSession.convex,
}));

jest.mock('../convex', () => ({
  useQueryWithStatus: () => mockSession.mine,
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

jest.mock('../../notifications/push', () => ({
  unregisterStoredPushToken: async () => undefined,
}));

jest.mock('../../logging/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

function mineOf(accountKind: FakeMine['accountKind'], entry: FakeEntry): FakeSession['mine'] {
  return { status: 'success', data: { accountKind, households: [entry] }, error: undefined };
}

const PAIRED_MINE = mineOf('device', {
  household: { _id: 'h1' },
  role: null,
  deviceKind: 'senior_phone',
});

const CAREGIVER_MINE = mineOf('caregiver', {
  household: { _id: 'h1' },
  role: 'primary',
  deviceKind: null,
});

function Probe({ onRender }: { onRender: (decision: SessionDecision) => void }): null {
  onRender(useSession());
  return null;
}

let renderer: ReactTestRenderer | null = null;
let shown: SessionDecision | null = null;

function record(decision: SessionDecision): void {
  shown = decision;
}

function render(session: Partial<FakeSession>): SessionDecision | null {
  Object.assign(mockSession, session);
  act(() => {
    if (renderer === null) renderer = create(<Probe onRender={record} />);
    else renderer.update(<Probe onRender={record} />);
  });
  return shown;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  shown = null;
  Object.assign(mockSession, signedInLoading());
});

describe('useSession', () => {
  it('keeps showing the paired device while the session reloads', () => {
    const paired = { state: 'paired', device: { householdId: 'h1', kind: 'senior_phone' } };
    expect(render({ mine: PAIRED_MINE })).toEqual(paired);
    expect(render({ mine: PENDING })).toEqual(paired);
    expect(render({ convex: { isLoading: true, isAuthenticated: false } })).toEqual(paired);
  });

  it('keeps showing the caregiver home while the session reloads', () => {
    const caregiver = { state: 'caregiver', home: { householdId: 'h1', role: 'primary' } };
    expect(render({ mine: CAREGIVER_MINE })).toEqual(caregiver);
    expect(render({ mine: PENDING })).toEqual(caregiver);
  });

  it('shows loading, not the signed-out screen, when a signed-out session starts loading', () => {
    expect(render({ clerk: { isLoaded: true, isSignedIn: false } })).toEqual({
      state: 'signedOut',
    });
    expect(render({ clerk: { isLoaded: false, isSignedIn: false } })).toEqual({
      state: 'loading',
    });
  });
});
