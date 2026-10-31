// sunny_app/src/caregiver/CaregiverApp.tsx
//
// Purpose: The caregiver side of the app, rendered full screen on the app background once a
// caregiver is signed in and has chosen a household. It owns the tab state (Home or Chat),
// follows the household's day view once (useDayView) for the Home tab and the Chat header, and
// signs the caregiver out from the account button (Clerk) after a confirmation. Both tabs stay
// mounted so a half-typed chat message survives a tab switch; the inactive one is hidden.
// The caregiver's role decides what they may do: viewers cannot claim alerts or message Sunny.
//
// Last modified: 2026-10-31

import { useAuth } from '@clerk/expo';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import type { HouseholdId } from '../backend/convexApi';
import type { CaregiverRole } from '../backend/pairing';
import { useDayView } from '../day/useDayView';
import { logger } from '../logging/logger';
import { BACKGROUND } from '../theme/colors';
import { CaregiverChatScreen } from './CaregiverChatScreen';
import { CaregiverHomeScreen } from './CaregiverHomeScreen';
import { CaregiverTabBar, type CaregiverTab } from './CaregiverTabBar';

export type { CaregiverRole };

/** Props for CaregiverApp. */
export interface CaregiverAppProps {
  householdId: HouseholdId;
  role: CaregiverRole;
}

/**
 * purpose: Render the caregiver app: the Home or Chat tab and the floating tab bar.
 * @param props: (CaregiverAppProps) The household and the caregiver's role in it.
 * @return: (JSX.Element) The full-screen caregiver UI.
 */
export function CaregiverApp({ householdId, role }: CaregiverAppProps) {
  const [tab, setTab] = useState<CaregiverTab>('home');
  const { signOut } = useAuth();
  const dayView = useDayView(householdId);
  const isEditor = role !== 'viewer';

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
    <View style={styles.root}>
      <View style={tab === 'home' ? styles.tab : styles.hidden}>
        <CaregiverHomeScreen
          dayView={dayView}
          canClaim={isEditor}
          onAccountPress={confirmSignOut}
        />
      </View>
      <View style={tab === 'chat' ? styles.tab : styles.hidden}>
        <CaregiverChatScreen
          householdId={householdId}
          seniorName={dayView.day?.seniorPreferredName ?? null}
          canSend={isEditor}
        />
      </View>
      <CaregiverTabBar active={tab} onChange={setTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
  tab: { flex: 1 },
  hidden: { display: 'none' },
});
