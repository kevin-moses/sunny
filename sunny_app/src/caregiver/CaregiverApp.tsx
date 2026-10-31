// sunny_app/src/caregiver/CaregiverApp.tsx
//
// Purpose: STUB of the caregiver app's root, rendered by App.tsx for a signed-in caregiver who
// is in a household. It only fixes the contract (props and CaregiverRole); the real
// implementation (tabs, screens, sign out) replaces this file.
//
// Last modified: 2026-10-30

import type { FunctionReturnType } from 'convex/server';
import { StyleSheet, Text, View } from 'react-native';

import type { api, HouseholdId } from '../backend/convexApi';
import { BACKGROUND, colors } from '../theme/colors';

/** A caregiver's role in the household. */
export type CaregiverRole = NonNullable<
  FunctionReturnType<typeof api.households.mine>[number]['role']
>;

/** Props for CaregiverApp. */
export interface CaregiverAppProps {
  householdId: HouseholdId;
  role: CaregiverRole;
}

/**
 * purpose: Placeholder caregiver home.
 * @param _props: (CaregiverAppProps) The household and the caregiver's role (unused by the stub).
 * @return: (JSX.Element) A centered "Caregiver home" label.
 */
export function CaregiverApp(_props: CaregiverAppProps) {
  return (
    <View style={styles.root}>
      <Text style={styles.text}>Caregiver home</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: BACKGROUND },
  text: { fontSize: 20, color: colors.text },
});
