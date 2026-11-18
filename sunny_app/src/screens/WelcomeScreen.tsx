import { FormScreen, formStyles } from '../components/FormScreen';
import { PrimaryButton } from '../components/PrimaryButton';

interface WelcomeScreenProps {
  onCaregiver: () => void;
  onSeniorDevice: () => void;
}

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
