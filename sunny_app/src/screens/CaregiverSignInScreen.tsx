import { useSignIn, useSignUp } from '@clerk/expo/legacy';
import { useState } from 'react';
import { Text, TextInput } from 'react-native';

import {
  cleanCode,
  findEmailCodeFactorId,
  isCompleteCode,
  isValidEmail,
  normalizeEmail,
  shouldFallBackToSignUp,
  signInErrorMessage,
  SIGN_IN_INCOMPLETE_MESSAGE,
} from '../backend/caregiverAuth';
import { FormScreen, formStyles } from '../components/FormScreen';
import { PrimaryButton } from '../components/PrimaryButton';
import { TextButton } from '../components/TextButton';
import { useBusyAction } from '../components/useBusyAction';
import { logger } from '../logging/logger';
import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

type Flow = 'signIn' | 'signUp';

type SignInResource = Extract<ReturnType<typeof useSignIn>, { isLoaded: true }>['signIn'];
type SignUpResource = Extract<ReturnType<typeof useSignUp>, { isLoaded: true }>['signUp'];
type SetActive = Extract<ReturnType<typeof useSignIn>, { isLoaded: true }>['setActive'];

interface CaregiverSignInScreenProps {
  onBack?: () => void;
}

async function sendCode(flow: Flow, signIn: SignInResource, signUp: SignUpResource): Promise<void> {
  if (flow === 'signUp') {
    await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    return;
  }
  const emailAddressId = findEmailCodeFactorId(signIn.supportedFirstFactors);
  if (emailAddressId === null) throw new Error('No email code factor for this account');
  await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId });
}

async function startFlow(
  signIn: SignInResource,
  signUp: SignUpResource,
  email: string,
): Promise<Flow> {
  try {
    const attempt = await signIn.create({ identifier: email });
    await sendCode('signIn', attempt, signUp);
    return 'signIn';
  } catch (error) {
    if (!shouldFallBackToSignUp(error)) throw error;
  }
  await signUp.create({ emailAddress: email });
  await sendCode('signUp', signIn, signUp);
  return 'signUp';
}

async function verifyCode(
  flow: Flow,
  signIn: SignInResource,
  signUp: SignUpResource,
  code: string,
): Promise<string | null> {
  const attempt =
    flow === 'signIn'
      ? await signIn.attemptFirstFactor({ strategy: 'email_code', code })
      : await signUp.attemptEmailAddressVerification({ code });
  return attempt.status === 'complete' ? attempt.createdSessionId : null;
}

interface EmailStepProps {
  email: string;
  onChangeEmail: (text: string) => void;
  message: string | null;
  busy: boolean;
  ready: boolean;
  onSend: () => void;
}

function EmailStep({ email, onChangeEmail, message, busy, ready, onSend }: EmailStepProps) {
  const theme = useTheme();
  return (
    <>
      <TextInput
        accessibilityLabel="Email address"
        value={email}
        onChangeText={onChangeEmail}
        placeholder="you@example.com"
        placeholderTextColor={colors.secondaryText}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        editable={!busy}
        style={[formStyles.input, { borderRadius: theme.cornerRadius }]}
      />
      {message !== null && <Text style={formStyles.error}>{message}</Text>}
      <PrimaryButton
        label="Send code"
        accessibilityHint="Emails you a 6-digit sign-in code"
        disabled={!ready || !isValidEmail(email)}
        busy={busy}
        onPress={onSend}
        style={formStyles.button}
      />
    </>
  );
}

interface CodeStepProps {
  code: string;
  onChangeCode: (text: string) => void;
  message: string | null;
  busy: boolean;
  ready: boolean;
  onVerify: () => void;
  onResend: () => void;
  onChangeEmail: () => void;
}

function CodeStep({
  code,
  onChangeCode,
  message,
  busy,
  ready,
  onVerify,
  onResend,
  onChangeEmail,
}: CodeStepProps) {
  const theme = useTheme();
  return (
    <>
      <TextInput
        accessibilityLabel="Email code"
        value={code}
        onChangeText={(text) => onChangeCode(cleanCode(text))}
        placeholder="123456"
        placeholderTextColor={colors.secondaryText}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus
        editable={!busy}
        style={[formStyles.input, formStyles.codeInput, { borderRadius: theme.cornerRadius }]}
      />
      {message !== null && <Text style={formStyles.error}>{message}</Text>}
      <PrimaryButton
        label="Sign in"
        disabled={!ready || !isCompleteCode(code)}
        busy={busy}
        onPress={onVerify}
        style={formStyles.button}
      />
      <TextButton label="Resend code" disabled={busy} onPress={onResend} />
      <TextButton label="Use a different email" disabled={busy} onPress={onChangeEmail} />
    </>
  );
}

export function CaregiverSignInScreen({ onBack }: CaregiverSignInScreenProps) {
  const signInHook = useSignIn();
  const signUpHook = useSignUp();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [flow, setFlow] = useState<Flow | null>(null);
  const { busy, message, setMessage, run } = useBusyAction(signInErrorMessage, (error) =>
    logger.warning('CaregiverSignIn', `Clerk step failed: ${signInErrorMessage(error)}`),
  );
  const clerk: { signIn: SignInResource; signUp: SignUpResource; setActive: SetActive } | null =
    signInHook.isLoaded && signUpHook.isLoaded
      ? { signIn: signInHook.signIn, signUp: signUpHook.signUp, setActive: signInHook.setActive }
      : null;

  const handleSendCode = (): Promise<void> =>
    run(async () => {
      if (clerk === null) return;
      const started = await startFlow(clerk.signIn, clerk.signUp, normalizeEmail(email));
      setCode('');
      setFlow(started);
    });

  const handleResend = (): Promise<void> =>
    run(async () => {
      if (clerk === null || flow === null) return;
      await sendCode(flow, clerk.signIn, clerk.signUp);
    });

  const handleVerify = (): Promise<void> =>
    run(async () => {
      if (clerk === null || flow === null) return;
      const sessionId = await verifyCode(flow, clerk.signIn, clerk.signUp, code);
      if (sessionId === null) {
        setMessage(SIGN_IN_INCOMPLETE_MESSAGE);
        return;
      }
      await clerk.setActive({ session: sessionId });
    });

  const handleChangeEmail = (): void => {
    setFlow(null);
    setCode('');
    setMessage(null);
  };

  const awaitingCode = flow !== null;
  return (
    <FormScreen
      title={awaitingCode ? 'Check your email' : 'Caregiver sign in'}
      subtitle={
        awaitingCode
          ? `We sent a 6-digit code to ${normalizeEmail(email)}.`
          : 'Enter your email and we will send you a code.'
      }
    >
      {awaitingCode ? (
        <CodeStep
          code={code}
          onChangeCode={setCode}
          message={message}
          busy={busy}
          ready={clerk !== null}
          onVerify={() => void handleVerify()}
          onResend={() => void handleResend()}
          onChangeEmail={handleChangeEmail}
        />
      ) : (
        <EmailStep
          email={email}
          onChangeEmail={setEmail}
          message={message}
          busy={busy}
          ready={clerk !== null}
          onSend={() => void handleSendCode()}
        />
      )}
      {onBack !== undefined && <TextButton label="Back" disabled={busy} onPress={onBack} />}
    </FormScreen>
  );
}
