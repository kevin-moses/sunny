import { createContext, useContext } from 'react';

export const TabBarInsetContext = createContext(0);

export function useTabBarInset(): number {
  return useContext(TabBarInsetContext);
}

export const NoteFocusContext = createContext<(focused: boolean) => void>(() => {});

export function useReportNoteFocus(): (focused: boolean) => void {
  return useContext(NoteFocusContext);
}
