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
import { signOutCaregiver } from '../notifications/caregiverPush';
import { useDiscardNotificationTaps } from '../notifications/push';
import { colors, ROUNDED_FONT } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

type Mode = 'choose' | 'join' | 'create';

const TITLES: Record<Mode, string> = {
  choose: 'Your family',
  join: 'Join a household',
  create: 'Set up a household',
};

function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  editable: boolean;
  autoFocus?: boolean;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
}

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

export function CaregiverOnboardingScreen() {
  const { signOut } = useAuth();
  useDiscardNotificationTaps();
  const [mode, setMode] = useState<Mode>('choose');
  const [code, setCode] = useState('');
  const [seniorName, setSeniorName] = useState('');
  const [myName, setMyName] = useState('');
  const [timezone, setTimezone] = useState(deviceTimezone);
  const [done, setDone] = useState(false);
  const { busy, message, setMessage, run } = useBusyAction(errorMessage);
  const locked = busy || done;

  const runCall = (call: () => Promise<unknown>): Promise<void> =>
    run(async () => {
      await call();
      setDone(true);
    });

  const handleJoin = (): Promise<void> =>
    runCall(() =>
      callMutation(api.households.redeemJoinCode, { code, displayName: myName.trim() }),
    );

  const handleCreate = (): Promise<void> =>
    runCall(() =>
      callMutation(api.households.create, {
        seniorPreferredName: seniorName.trim(),
        caregiverDisplayName: myName.trim(),
        timezone: timezone.trim(),
      }),
    );

  const handleSignOut = async (): Promise<void> => {
    setMessage(null);
    try {
      await signOutCaregiver(signOut);
    } catch (error) {
      logger.warning('Onboarding', `Sign out failed: ${errorMessage(error)}`);
      setMessage('Could not sign out. Please try again.');
    }
  };

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
