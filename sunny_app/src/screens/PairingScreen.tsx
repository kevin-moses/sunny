// sunny_app/src/screens/PairingScreen.tsx
//
// Purpose: First-run screen for a senior device: enter the 8-character join code a
// caregiver created in the caregiver app (or with supabase/scripts/caregiver.ts codes).
// The code decides whether this device becomes the senior's phone or the home display.
// Usually a caregiver does this for the senior during setup.
//
// Last modified: 2026-10-28

import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pair, type PairedDevice } from '../backend/pairing';
import { errorMessage } from '../errors';
import { PrimaryButton } from '../components/PrimaryButton';
import { colors, GRID, ROUNDED_FONT } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

const CODE_LENGTH = 8;

/**
 * purpose: Join-code entry that pairs this device with a household.
 * @param props: ({ onPaired }) Called with the pairing once the code is accepted.
 * @return: (JSX.Element) The screen.
 */
export function PairingScreen({ onPaired }: { onPaired: (device: PairedDevice) => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const cleanLength = code.replace(/[^A-Za-z0-9]/g, '').length;

  /**
   * purpose: Redeem the code and report the pairing; show the server's message on failure.
   * @return: (Promise<void>) resolves when the pairing succeeded or its failure is shown
   */
  const handlePair = async (): Promise<void> => {
    setMessage(null);
    try {
      onPaired(await pair(code));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 8 * GRID, paddingBottom: insets.bottom + 8 * GRID },
        ]}
      >
        <Text accessibilityRole="header" style={styles.title}>
          Connect to your family
        </Text>
        <Text style={styles.subtitle}>Enter the code from the Sunny caregiver app.</Text>
        <TextInput
          accessibilityLabel="Join code"
          value={code}
          onChangeText={setCode}
          placeholder="Code"
          placeholderTextColor={colors.secondaryText}
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          style={[styles.input, { borderRadius: theme.cornerRadius }]}
        />
        {message !== null && <Text style={styles.error}>{message}</Text>}
        <PrimaryButton
          label="Connect"
          accessibilityHint="Connects this device to your family using the code"
          disabled={cleanLength !== CODE_LENGTH}
          onPress={handlePair}
          style={styles.button}
        />
      </ScrollView>
    </KeyboardAvoidingView>
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
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    color: colors.text,
  },
  subtitle: {
    fontFamily: ROUNDED_FONT,
    fontSize: 20,
    textAlign: 'center',
    color: colors.secondaryText,
  },
  input: {
    alignSelf: 'stretch',
    maxWidth: 420,
    width: '100%',
    padding: 4 * GRID,
    fontFamily: 'Menlo',
    fontSize: 34,
    fontWeight: '600',
    textAlign: 'center',
    color: colors.text,
    backgroundColor: colors.overlayMedium,
  },
  error: { fontSize: 18, textAlign: 'center', color: colors.seriousForeground },
  button: { maxWidth: 420, width: '100%' },
});
