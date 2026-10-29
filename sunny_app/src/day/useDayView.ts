// sunny_app/src/day/useDayView.ts
//
// Purpose: React hook that loads the household's day view (get_day_view RPC) and keeps it
// fresh for both senior surfaces: loads on mount, refreshes every 30 seconds while the app
// is active, and refreshes immediately when the app becomes active again (the timer is
// stopped while the app is in the background and restarted on return). A failed refresh
// keeps the last good day on screen and sets an offline flag. A response superseded by a
// newer request, or arriving after the hook was torn down, is ignored. If the server says
// this device no longer belongs to the household (403), the device is unpaired.
// The app shell calls this once for the paired household so the day survives a
// conversation, and hands the result to the Today and Display screens.
//
// Last modified: 2026-10-28

import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { BackendError, callRpc } from '../backend/api';
import { unpair } from '../backend/pairing';
import { errorMessage } from '../errors';
import { buildAgenda } from './format';
import type { AgendaItem, DayViewData } from './types';

const REFRESH_INTERVAL_MS = 30_000;

/** What useDayView returns. */
export interface DayViewState {
  day: DayViewData | null;
  agenda: AgendaItem[];
  errorMessage: string | null;
  /** True when the latest refresh failed and the screen shows the last good day. */
  isOffline: boolean;
}

/**
 * purpose: Load and periodically refresh the household's day view.
 * @param householdId: (string) Household the device is paired with.
 * @return: (DayViewState) The day, its agenda, and the error / offline state.
 */
export function useDayView(householdId: string): DayViewState {
  const [day, setDay] = useState<DayViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counts requests; bumped by every refresh and by cleanup, so only the newest live
  // request may update state.
  const latestRequest = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    /**
     * purpose: Load the day view; only the newest live request may update state.
     * @return: (Promise<void>) resolves when the request finished
     */
    const refresh = async (): Promise<void> => {
      latestRequest.current += 1;
      const mine = latestRequest.current;
      try {
        const loaded = await callRpc<DayViewData>('get_day_view', { p_household_id: householdId });
        if (mine !== latestRequest.current) return;
        setDay(loaded);
        setError(null);
      } catch (e) {
        if (mine !== latestRequest.current) return;
        if (e instanceof BackendError && e.status === 403) {
          void unpair(); // The device was removed from the household.
          return;
        }
        setError(errorMessage(e));
      }
    };

    /**
     * purpose: Stop the periodic refresh.
     * @return: (void)
     */
    const stop = (): void => {
      clearInterval(timer);
      timer = undefined;
    };

    /**
     * purpose: Refresh now and restart the periodic refresh.
     * @return: (void)
     */
    const start = (): void => {
      stop();
      void refresh();
      timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    };

    if (AppState.currentState !== 'background') start();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });
    return () => {
      latestRequest.current += 1;
      stop();
      subscription.remove();
    };
  }, [householdId]);

  const agenda = useMemo(() => buildAgenda(day), [day]);
  return { day, agenda, errorMessage: error, isOffline: error !== null };
}
