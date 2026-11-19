import { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import type { SessionDecision } from '../backend/pairing';
import type { DayViewData } from '../day/types';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import {
  clearWidget,
  reloadWidget,
  syncWidget,
  widgetHolderOf,
  widgetReloadKey,
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

export function useWidgetReload(day: DayViewData | null): void {
  const key = useMemo(() => widgetReloadKey(day), [day]);

  useEffect(() => {
    if (key !== null) reloadWidget();
  }, [key]);
}
