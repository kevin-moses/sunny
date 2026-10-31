// sunny_app/src/screens/PairingScreen.tsx
//
// Purpose: First-run screen for a senior device: enter the 8-character join code a caregiver
// created in the caregiver app. The code decides whether this device becomes the senior's phone
// or the home display. Submitting the same code again after a failure reuses the pairing nonce
// kept by pair(), so a retry after a lost response recovers. The server's message is shown when
// the code is rejected. After pair() succeeds the button stays disabled; the app shell leaves
// this screen when Convex reports the device authenticated. onBack (optional) adds a Back button
// that returns to the welcome choice.
//
// Last modified: 2026-10-31

import { useState } from 'react';
import { Text, TextInput } from 'react-native';

import { pair } from '../backend/pairing';
import { errorMessage } from '../errors';
import { FormScreen, formStyles } from '../components/FormScreen';
import { PrimaryButton } from '../components/PrimaryButton';
import { TextButton } from '../components/TextButton';
import { useBusyAction } from '../components/useBusyAction';
import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

const CODE_LENGTH = 8;

/** Props for PairingScreen. */
interface PairingScreenProps {
  /** Returns to the welcome choice; the Back button is hidden without it. */
  onBack?: () => void;
}

/**
 * purpose: Join-code entry that pairs this device with a household.
 * @param props: (PairingScreenProps) Optional onBack handler.
 * @return: (JSX.Element) The screen.
 */
export function PairingScreen({ onBack }: PairingScreenProps = {}) {
  const theme = useTheme();
  const [code, setCode] = useState('');
  const [connected, setConnected] = useState(false);
  const { message, run } = useBusyAction(errorMessage);
  const cleanLength = code.replace(/[^A-Za-z0-9]/g, '').length;

  /**
   * purpose: Redeem the code; show the server's message on failure.
   * @return: (Promise<void>) resolves when the pairing succeeded or its failure is shown
   */
  const handlePair = (): Promise<void> =>
    run(async () => {
      await pair(code);
      setConnected(true);
    });

  return (
    <FormScreen
      title="Connect to your family"
      subtitle="Enter the code from the Sunny caregiver app."
    >
      <TextInput
        accessibilityLabel="Join code"
        value={code}
        onChangeText={setCode}
        placeholder="Code"
        placeholderTextColor={colors.secondaryText}
        autoCapitalize="characters"
        autoCorrect={false}
        autoFocus
        style={[formStyles.input, formStyles.codeInput, { borderRadius: theme.cornerRadius }]}
      />
      {message !== null && <Text style={formStyles.error}>{message}</Text>}
      <PrimaryButton
        label="Connect"
        accessibilityHint="Connects this device to your family using the code"
        disabled={cleanLength !== CODE_LENGTH || connected}
        onPress={handlePair}
        style={formStyles.button}
      />
      {onBack !== undefined && <TextButton label="Back" disabled={connected} onPress={onBack} />}
    </FormScreen>
  );
}
