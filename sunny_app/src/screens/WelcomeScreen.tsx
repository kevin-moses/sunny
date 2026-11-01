// sunny_app/src/screens/WelcomeScreen.tsx
//
// Purpose: The first screen when nobody is signed in: asks who is using this phone. "I'm a family
// caregiver" leads to the caregiver sign-in; "Set up a senior's device" leads to the join-code
// pairing screen. The choice itself is made by the caller (App.tsx), which owns the navigation.
//
// Last modified: 2026-10-31

import { FormScreen, formStyles } from '../components/FormScreen';
import { PrimaryButton } from '../components/PrimaryButton';

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
  return (
    <FormScreen title="Welcome to Sunny" subtitle="Who is using this phone?">
      <PrimaryButton
        label="I'm a family caregiver"
        accessibilityHint="Sign in or create an account to look after a family"
        onPress={onCaregiver}
        style={formStyles.button}
      />
      <PrimaryButton
        label="Set up a senior's device"
        accessibilityHint="Connect this phone to a family using a join code"
        onPress={onSeniorDevice}
        style={formStyles.button}
      />
    </FormScreen>
  );
}
