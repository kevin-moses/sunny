// sunny_app/src/screens/CaregiverOnboardingScreen.tsx
//
// Purpose: Shown to a signed-in caregiver who is not in a household yet. A first choice leads to
// one of two forms: join with an invite code from another caregiver (code and "Your name" ->
// households.redeemJoinCode), or set up a new household (what the parent likes to be called,
// "Your name" and an editable timezone defaulting to the phone's -> households.create). The
// backend's message is shown inline when a call fails. After a call succeeds the screen does
// nothing more: households.mine updates reactively and the app shell moves to the caregiver
// home. A "Sign out" button (Clerk) lets the user leave with a different account.
//
// Last modified: 2026-10-31

import { useAuth } from '@clerk/expo';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, type TextInputProps } from 'react-native';

import { callMutation } from '../backend/api';
import { api } from '../backend/convexApi';
import { FormScreen, formStyles } from '../components/FormScreen';
import { PrimaryButton } from '../components/PrimaryButton';
import { TextButton } from '../components/TextButton';
import { useBusyAction } from '../components/useBusyAction';
import { errorMessage } from '../errors';
import { logger } from '../logging/logger';
import { colors, ROUNDED_FONT } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

/** Which part of onboarding is showing. */
type Mode = 'choose' | 'join' | 'create';

/** The header of each part of onboarding. */
const TITLES: Record<Mode, string> = {
  choose: 'Your family',
  join: 'Join a household',
  create: 'Set up a household',
};

/**
 * purpose: The phone's IANA timezone, as the default for a new household.
 * @return: (string) For example "America/New_York"; empty when the phone does not report one.
 */
function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
}

/** Props for Field. */
interface FieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  editable: boolean;
  autoFocus?: boolean;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
}

/**
 * purpose: A labeled text field.
 * @param props: (FieldProps) The label, value, change handler, editable flag and text input
 *        options.
 * @return: (JSX.Element) The label above the input.
 */
function Field({ label, ...input }: FieldProps) {
  const theme = useTheme();
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.secondaryText}
        style={[formStyles.input, { borderRadius: theme.cornerRadius }]}
        {...input}
      />
    </>
  );
}

/**
 * purpose: Let a caregiver without a household join one with an invite code or create one.
 * @return: (JSX.Element) The screen.
 */
export function CaregiverOnboardingScreen() {
  const { signOut } = useAuth();
  const [mode, setMode] = useState<Mode>('choose');
  const [code, setCode] = useState('');
  const [seniorName, setSeniorName] = useState('');
  const [myName, setMyName] = useState('');
  const [timezone, setTimezone] = useState(deviceTimezone);
  const [done, setDone] = useState(false);
  const { busy, message, setMessage, run } = useBusyAction(errorMessage);
  const locked = busy || done;

  /**
   * purpose: Run one backend call; on success the screen stays locked until the shell replaces it.
   * @param call: (() => Promise<unknown>) The call; may throw.
   * @return: (Promise<void>) Resolves when the call finished and any failure is shown.
   */
  const runCall = (call: () => Promise<unknown>): Promise<void> =>
    run(async () => {
      await call();
      setDone(true);
    });

  /**
   * purpose: Join the household the invite code belongs to.
   * @return: (Promise<void>) Resolves when joined or the failure is shown.
   */
  const handleJoin = (): Promise<void> =>
    runCall(() =>
      callMutation(api.households.redeemJoinCode, { code, displayName: myName.trim() }),
    );

  /**
   * purpose: Create a household with this caregiver as its primary caregiver.
   * @return: (Promise<void>) Resolves when created or the failure is shown.
   */
  const handleCreate = (): Promise<void> =>
    runCall(() =>
      callMutation(api.households.create, {
        seniorPreferredName: seniorName.trim(),
        caregiverDisplayName: myName.trim(),
        timezone: timezone.trim(),
      }),
    );

  /**
   * purpose: Sign the account out of Clerk; the shell then shows the welcome screen.
   * @return: (Promise<void>) Resolves when signed out or the failure is shown.
   */
  const handleSignOut = async (): Promise<void> => {
    setMessage(null);
    try {
      await signOut();
    } catch (error) {
      logger.warning('Onboarding', `Sign out failed: ${errorMessage(error)}`);
      setMessage('Could not sign out. Please try again.');
    }
  };

  /**
   * purpose: Go back to the choice between joining and creating.
   * @return: (void)
   */
  const handleBack = (): void => {
    setMode('choose');
    setMessage(null);
  };

  const joinReady = code.trim() !== '' && myName.trim() !== '';
  const createReady = seniorName.trim() !== '' && myName.trim() !== '' && timezone.trim() !== '';

  return (
    <FormScreen title={TITLES[mode]}>
      {mode === 'choose' && (
        <>
          <Text style={formStyles.subtitle}>
            Join a family that already uses Sunny, or start one.
          </Text>
          <PrimaryButton
            label="Join with an invite code"
            onPress={() => setMode('join')}
            style={formStyles.button}
          />
          <PrimaryButton
            label="Set up a new household"
            onPress={() => setMode('create')}
            style={formStyles.button}
          />
        </>
      )}
      {mode === 'join' && (
        <>
          <Field
            label="Invite code"
            value={code}
            onChangeText={setCode}
            editable={!locked}
            autoFocus
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Field label="Your name" value={myName} onChangeText={setMyName} editable={!locked} />
          <PrimaryButton
            label="Join"
            disabled={!joinReady || done}
            busy={busy}
            onPress={handleJoin}
            style={formStyles.button}
          />
        </>
      )}
      {mode === 'create' && (
        <>
          <Field
            label="What does your parent like to be called?"
            value={seniorName}
            onChangeText={setSeniorName}
            editable={!locked}
            autoFocus
          />
          <Field label="Your name" value={myName} onChangeText={setMyName} editable={!locked} />
          <Field
            label="Timezone"
            value={timezone}
            onChangeText={setTimezone}
            editable={!locked}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <PrimaryButton
            label="Create household"
            disabled={!createReady || done}
            busy={busy}
            onPress={handleCreate}
            style={formStyles.button}
          />
        </>
      )}
      {message !== null && <Text style={formStyles.error}>{message}</Text>}
      {mode !== 'choose' && <TextButton label="Back" disabled={locked} onPress={handleBack} />}
      <TextButton label="Sign out" disabled={locked} onPress={() => void handleSignOut()} />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  label: {
    alignSelf: 'stretch',
    maxWidth: 420,
    width: '100%',
    fontFamily: ROUNDED_FONT,
    fontSize: 18,
    fontWeight: '600',
    color: colors.secondaryText,
  },
});
