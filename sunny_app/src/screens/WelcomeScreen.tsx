// sunny_app/src/screens/WelcomeScreen.tsx
//
// Purpose: The first screen when nobody is signed in: asks who is using this phone. "I'm a family
// caregiver" leads to the caregiver sign-in; "Set up a senior's device" leads to the join-code
// pairing screen. The choice itself is made by the caller (App.tsx), which owns the navigation.
//
// Last modified: 2026-10-30

import { ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '../components/PrimaryButton';
import { colors, GRID, ROUNDED_FONT } from '../theme/colors';

/** Props for WelcomeScreen. */
interface WelcomeScreenProps {
  /** The user is a family caregiver. */
  onCaregiver: () => void;
  /** The user is setting up a senior's device. */
  onSeniorDevice: () => void;
}

/**
 * purpose: Welcome the user and let them choose between caregiver sign-in and senior device
 *          setup.
 * @param props: (WelcomeScreenProps) Handlers for the two choices.
 * @return: (JSX.Element) The screen.
 */
export function WelcomeScreen({ onCaregiver, onSeniorDevice }: WelcomeScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 8 * GRID, paddingBottom: insets.bottom + 8 * GRID },
      ]}
    >
      <Text accessibilityRole="header" style={styles.title}>
        Welcome to Sunny
      </Text>
      <Text style={styles.subtitle}>Who is using this phone?</Text>
      <PrimaryButton
        label="I'm a family caregiver"
        accessibilityHint="Sign in or create an account to look after a family"
        onPress={onCaregiver}
        style={styles.button}
      />
      <PrimaryButton
        label="Set up a senior's device"
        accessibilityHint="Connect this phone to a family using a join code"
        onPress={onSeniorDevice}
        style={styles.button}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6 * GRID,
    paddingHorizontal: 8 * GRID,
  },
  title: {
    fontFamily: ROUNDED_FONT,
    fontSize: 36,
    fontWeight: '700',
    textAlign: 'center',
    color: colors.text,
  },
  subtitle: {
    fontFamily: ROUNDED_FONT,
    fontSize: 22,
    textAlign: 'center',
    color: colors.secondaryText,
  },
  button: { maxWidth: 420, width: '100%' },
});
