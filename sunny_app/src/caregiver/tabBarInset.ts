// sunny_app/src/caregiver/tabBarInset.ts
//
// Purpose: How CaregiverApp tells its tab screens how much room to leave at the bottom for the
// floating tab bar. CaregiverApp owns the bar's geometry and provides the inset through
// TabBarInsetContext (0 while the bar is hidden behind the keyboard); screens read it with
// useTabBarInset and add it to their bottom padding.
//
// Last modified: 2026-10-31

import { createContext, useContext } from 'react';

/** Points of bottom space the tab screens must leave free; 0 when the tab bar is hidden. */
export const TabBarInsetContext = createContext(0);

/**
 * purpose: Read how much bottom space the floating tab bar needs.
 * @return: (number) Points to leave free at the bottom of a tab screen.
 */
export function useTabBarInset(): number {
  return useContext(TabBarInsetContext);
}
