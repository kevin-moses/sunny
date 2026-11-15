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

interface PairingScreenProps {
  onBack?: () => void;
}

export function PairingScreen({ onBack }: PairingScreenProps = {}) {
  const theme = useTheme();
  const [code, setCode] = useState('');
  const [connected, setConnected] = useState(false);
  const { message, run } = useBusyAction(errorMessage);
  const cleanLength = code.replace(/[^A-Za-z0-9]/g, '').length;

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
