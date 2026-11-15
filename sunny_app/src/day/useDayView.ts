import { useConvexConnectionState } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import type { ConnectionState } from 'convex/browser';

import { toBackendError } from '../backend/api';
import { useQueryWithStatus } from '../backend/convex';
import { useLastDefined } from '../components/useLastDefined';
import { api, type HouseholdId } from '../backend/convexApi';
import { buildAgenda } from './format';
import type { AgendaItem, DayViewData } from './types';

const MS_PER_MINUTE = 60_000;

export interface DayViewState {
  day: DayViewData | null;
  agenda: AgendaItem[];
  errorMessage: string | null;
  isOffline: boolean;
}

type ConnectionLike = Pick<ConnectionState, 'isWebSocketConnected' | 'hasEverConnected'>;

export function isOfflineFrom(connection: ConnectionLike): boolean {
  return connection.hasEverConnected && !connection.isWebSocketConnected;
}

function useMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / MS_PER_MINUTE));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };

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

export function useDayView(householdId: HouseholdId): DayViewState {
  const minute = useMinute();
  const connection = useConvexConnectionState();
  const result = useQueryWithStatus(api.calendar.dayView, { householdId, minute });
  const day = useLastDefined(result.data) ?? null;

  const agenda = useMemo(() => buildAgenda(day), [day]);
  return {
    day,
    agenda,
    errorMessage: result.status === 'error' ? toBackendError(result.error).message : null,
    isOffline: isOfflineFrom(connection),
  };
}
