// sunny_app/src/caregiver/CaregiverApp.tsx
//
// Purpose: The caregiver side of the app, rendered full screen on the app background once a
// caregiver is signed in and has chosen a household. It owns the tab state (Home or Chat),
// follows the household's day view once (useDayView) for the Home tab and the Chat header, and
// signs the caregiver out from the account button (Clerk) after a confirmation. The Chat tab
// mounts on its first visit and then stays mounted so a half-typed message survives a tab
// switch; the inactive tab is hidden. It also owns the floating tab bar's geometry: the bar is
// hidden while the keyboard is up or a note field has focus (a hardware keyboard
// fires no keyboard events, so the field reports its focus through NoteFocusContext), and the room screens must leave for it is provided through
// useTabBarInset. The caregiver's role decides what they may do: viewers cannot claim alerts,
// mark tasks done or message Sunny.
//
// Last modified: 2026-11-01

import { useAuth } from '@clerk/expo';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CaregiverHome } from '../backend/pairing';
import { useDayView } from '../day/useDayView';
import { logger } from '../logging/logger';
import { BACKGROUND } from '../theme/colors';
import { useKeyboardVisible } from '../theme/useKeyboardVisible';
import { CaregiverChatScreen } from './CaregiverChatScreen';
import { CaregiverHomeScreen } from './CaregiverHomeScreen';
import { CaregiverTabBar, tabBarClearance, type CaregiverTab } from './CaregiverTabBar';
import { NoteFocusContext, TabBarInsetContext } from './tabBarInset';

/**
 * purpose: Render the caregiver app: the Home or Chat tab and the floating tab bar.
 * @param props: (CaregiverHome) The household and the caregiver's role in it.
 * @return: (JSX.Element) The full-screen caregiver UI.
 */
export function CaregiverApp({ householdId, role }: CaregiverHome) {
  const [tab, setTab] = useState<CaregiverTab>('home');
  const [chatVisited, setChatVisited] = useState(false);
  const { signOut, userId } = useAuth();
  const insets = useSafeAreaInsets();
  const softwareKeyboardVisible = useKeyboardVisible();
  const [noteFocused, setNoteFocused] = useState(false);
  const keyboardVisible = softwareKeyboardVisible || noteFocused;
  const dayView = useDayView(householdId);
  const isEditor = role !== 'viewer';

  /**
   * purpose: Switch tabs, remembering that Chat has been opened so it stays mounted.
   * @param next: (CaregiverTab) The tab to show.
   * @return: (void)
   */
  const selectTab = (next: CaregiverTab): void => {
    if (next === 'chat') setChatVisited(true);
    setTab(next);
  };

  /**
   * purpose: Ask for confirmation, then sign the caregiver out of Clerk.
   * @return: (void)
   */
  const confirmSignOut = (): void => {
    Alert.alert('Sign out', 'You will need to sign in again to see the week.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          signOut().catch((e: unknown) => {
            logger.warning('Caregiver', `Sign out failed: ${String(e)}`);
            Alert.alert('Could not sign out', 'Please try again.');
          });
        },
      },
    ]);
  };

  return (
    <NoteFocusContext.Provider value={setNoteFocused}>
      <TabBarInsetContext.Provider value={keyboardVisible ? 0 : tabBarClearance(insets.bottom)}>
        <View style={styles.root}>
          <View style={tab === 'home' ? styles.tab : styles.hidden}>
            <CaregiverHomeScreen
              dayView={dayView}
              canEdit={isEditor}
              userId={userId ?? null}
              onAccountPress={confirmSignOut}
            />
          </View>
          {chatVisited && (
            <View style={tab === 'chat' ? styles.tab : styles.hidden}>
              <CaregiverChatScreen
                householdId={householdId}
                seniorName={dayView.day?.seniorPreferredName ?? null}
                canSend={isEditor}
                userId={userId ?? null}
              />
            </View>
          )}
          {!keyboardVisible && <CaregiverTabBar active={tab} onChange={selectTab} />}
        </View>
      </TabBarInsetContext.Provider>
    </NoteFocusContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
  tab: { flex: 1 },
  hidden: { display: 'none' },
});
