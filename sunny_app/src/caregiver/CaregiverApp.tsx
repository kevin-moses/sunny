import { useAuth } from '@clerk/expo';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CaregiverHome } from '../backend/pairing';
import { useDayView } from '../day/useDayView';
import { logger } from '../logging/logger';
import { signOutCaregiver, useCaregiverPush } from '../notifications/caregiverPush';
import { BACKGROUND } from '../theme/colors';
import { useKeyboardVisible } from '../theme/useKeyboardVisible';
import { aboutTabLabel } from './aboutFormat';
import { CaregiverAboutScreen } from './CaregiverAboutScreen';
import { CaregiverChatScreen } from './CaregiverChatScreen';
import { CaregiverHomeScreen } from './CaregiverHomeScreen';
import { CaregiverTabBar, tabBarClearance, type CaregiverTab } from './CaregiverTabBar';
import { NoteFocusContext, TabBarInsetContext } from './tabBarInset';

export function CaregiverApp({ householdId, role }: CaregiverHome) {
  const [tab, setTab] = useState<CaregiverTab>('home');
  const [chatVisited, setChatVisited] = useState(false);
  const [aboutVisited, setAboutVisited] = useState(false);
  const { signOut, userId } = useAuth();
  const insets = useSafeAreaInsets();
  const softwareKeyboardVisible = useKeyboardVisible();
  const [noteFocused, setNoteFocused] = useState(false);
  const keyboardVisible = softwareKeyboardVisible || noteFocused;
  const dayView = useDayView(householdId);
  const isEditor = role !== 'viewer';
  const seniorName = dayView.day?.seniorPreferredName ?? null;

  const selectTab = (next: CaregiverTab): void => {
    if (next === 'chat') setChatVisited(true);
    if (next === 'about') setAboutVisited(true);
    setTab(next);
  };

  useCaregiverPush(householdId, isEditor, selectTab);

  const confirmSignOut = (): void => {
    Alert.alert('Sign out', 'You will need to sign in again to see the week.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          signOutCaregiver(signOut).catch((e: unknown) => {
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
                seniorName={seniorName}
                canSend={isEditor}
                userId={userId ?? null}
                active={tab === 'chat'}
              />
            </View>
          )}
          {aboutVisited && (
            <View style={tab === 'about' ? styles.tab : styles.hidden}>
              <CaregiverAboutScreen
                householdId={householdId}
                seniorName={seniorName}
                canEdit={isEditor}
              />
            </View>
          )}
          {!keyboardVisible && (
            <CaregiverTabBar
              active={tab}
              onChange={selectTab}
              aboutLabel={aboutTabLabel(seniorName)}
            />
          )}
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
