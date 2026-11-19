import { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import type { SessionDecision } from '../backend/pairing';
import type { DayViewData } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import {
  clearWidget,
  syncSurfaces,
  syncWidget,
  widgetHolderOf,
  surfaceSyncKey,
} from './widgetSync';

export function useWidgetSync(decision: SessionDecision): void {
  const holder = widgetHolderOf(decision);

  useEffect(() => {
    if (holder === 'undecided') return;
    if (holder === 'none') {
      clearWidget().catch((e: unknown) =>
        logger.warning('Widget', `Could not clear the widget: ${errorMessage(e)}`),
      );
      return;
    }
    void syncWidget();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncWidget();
    });
    return () => subscription.remove();
  }, [holder]);
}

export function useSurfaceSync(day: DayViewData | null): void {
  const key = useMemo(() => surfaceSyncKey(day), [day]);

  useEffect(() => {
    if (key !== null) syncSurfaces();
  }, [key]);
}
