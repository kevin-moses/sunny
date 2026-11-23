import { useConvexConnectionState } from 'convex/react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { SessionDecision } from '../backend/pairing';
import { oldestUnsentAt } from '../day/pressLog';
import type { DayViewData } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { phonePresses, readPressLog, sendPresses, showOnSurfaces } from './pressStore';
import { clearWidget, widgetHolderOf, surfaceSyncKey } from './widgetSync';

export const RETRY_MS = 30_000;

export const STUCK_MS = 10 * 60 * 1000;

export const STUCK_LOG_EVERY_MS = 60 * 60 * 1000;

function useResend(sending: boolean): void {
  const { isWebSocketConnected } = useConvexConnectionState();
  const seen = useSyncExternalStore(phonePresses.subscribe, phonePresses.getSeen);
  const unsentSince = useMemo(() => oldestUnsentAt(seen.presses), [seen]);

  useEffect(() => {
    if (sending && isWebSocketConnected) void sendPresses();
  }, [sending, isWebSocketConnected]);

  useEffect(() => {
    if (!sending || unsentSince === null) return;
    const timer = setInterval(() => void sendPresses(), RETRY_MS);
    return () => clearInterval(timer);
  }, [sending, unsentSince]);

  useEffect(() => {
    if (!sending || unsentSince === null || !isWebSocketConnected) return;
    const report = (): void =>
      logger.error('PressLog', 'A Done press or an Undo has waited over 10 minutes while online', {
        unsentSince,
      });
    let repeat: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(
      () => {
        report();
        repeat = setInterval(report, STUCK_LOG_EVERY_MS);
      },
      Math.max(0, unsentSince + STUCK_MS - Date.now()),
    );
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [sending, unsentSince, isWebSocketConnected]);
}

export function useWidgetSync(decision: SessionDecision): void {
  const holder = widgetHolderOf(decision);
  useResend(holder === 'seniorPhone');

  useEffect(() => {
    if (holder === 'undecided') return;
    if (holder === 'none') {
      clearWidget().catch((e: unknown) =>
        logger.warning('Widget', `Could not clear the widget: ${errorMessage(e)}`),
      );
      return;
    }
    const look = (): void => {
      void readPressLog();
      void sendPresses();
    };
    look();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') look();
    });
    return () => subscription.remove();
  }, [holder]);
}

export function useSurfaceSync(day: DayViewData | null): void {
  const key = useMemo(() => surfaceSyncKey(day), [day]);

  useEffect(() => {
    if (key !== null) void showOnSurfaces();
  }, [key]);
}
