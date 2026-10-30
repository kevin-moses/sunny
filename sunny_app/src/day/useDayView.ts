// sunny_app/src/day/useDayView.ts
//
// Purpose: React hook that follows the household's day view (calendar.dayView) for both senior
// surfaces as a live Convex subscription, with no polling. The server reads its clock when the
// query runs and Convex re-runs a query only when data it read changes, so the hook passes the
// current minute (a timer that ticks only while the app is active) to force a re-run, keeping
// "Next up" and the header current. While a new minute's result loads, the last loaded day
// stays on screen (a ref; the app shell keys the home screen by household, so it never crosses
// households). isOffline means the Convex socket is down after having connected once. Errors
// are only surfaced: a removed device is detected by the pairing derivation (usePairing).
//
// Last modified: 2026-10-29

import { useConvexConnectionState } from 'convex/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { ConnectionState } from 'convex/browser';

import { toBackendError } from '../backend/api';
import { useQueryWithStatus } from '../backend/convex';
import { api, type HouseholdId } from '../backend/convexApi';
import { buildAgenda } from './format';
import type { AgendaItem, DayViewData } from './types';

const MS_PER_MINUTE = 60_000;

/** What useDayView returns. */
export interface DayViewState {
  day: DayViewData | null;
  agenda: AgendaItem[];
  errorMessage: string | null;
  /** True when the connection to the backend is down; the screen shows the last good day. */
  isOffline: boolean;
}

/** The parts of the Convex connection state that decide whether the app is offline. */
type ConnectionLike = Pick<ConnectionState, 'isWebSocketConnected' | 'hasEverConnected'>;

/**
 * purpose: Decide whether to show the offline indicator.
 * @param connection: (ConnectionLike) The Convex connection state.
 * @return: (boolean) True once the client has connected and the socket is now down.
 */
export function isOfflineFrom(connection: ConnectionLike): boolean {
  return connection.hasEverConnected && !connection.isWebSocketConnected;
}

/**
 * purpose: The current minute counter (epoch ms / 60000, rounded down) that keeps the day
 *          view query fresh; it advances at each minute boundary while the app is active and
 *          is refreshed immediately when the app becomes active again.
 * @return: (number) The minute counter.
 */
function useMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / MS_PER_MINUTE));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * purpose: Stop the minute timer.
     * @return: (void)
     */
    const stop = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };

    /**
     * purpose: Publish the current minute and schedule the next boundary.
     * @return: (void)
     */
    const tick = (): void => {
      setMinute(Math.floor(Date.now() / MS_PER_MINUTE));
      stop();
      timer = setTimeout(tick, MS_PER_MINUTE - (Date.now() % MS_PER_MINUTE));
    };

    if (AppState.currentState !== 'background') tick();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
      else stop();
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, []);

  return minute;
}

/**
 * purpose: Follow the household's day view.
 * @param householdId: (HouseholdId) Household the device is paired with.
 * @return: (DayViewState) The day, its agenda, and the error / offline state.
 */
export function useDayView(householdId: HouseholdId): DayViewState {
  const minute = useMinute();
  const connection = useConvexConnectionState();
  const result = useQueryWithStatus(api.calendar.dayView, { householdId, minute });
  // The query returns nothing while a new minute's subscription loads; keep the last day.
  const lastDay = useRef<DayViewData | null>(null);
  /* eslint-disable react-hooks/refs -- a render-time cache of the last loaded value is the point */
  if (result.data !== undefined) lastDay.current = result.data;
  const day = result.data ?? lastDay.current;
  /* eslint-enable react-hooks/refs */

  const agenda = useMemo(() => buildAgenda(day), [day]);
  return {
    day,
    agenda,
    errorMessage: result.status === 'error' ? toBackendError(result.error).message : null,
    isOffline: isOfflineFrom(connection),
  };
}
