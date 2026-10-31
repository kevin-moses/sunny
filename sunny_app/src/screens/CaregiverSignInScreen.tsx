// sunny_app/src/screens/CaregiverSignInScreen.tsx
//
// Purpose: Caregiver sign-in with a Clerk email code, in two steps: the email, then the 6-digit
// code Clerk mails to it. It uses Clerk's classic (legacy) hooks from '@clerk/expo/legacy':
//   Sign-in:  signIn.create({ identifier }) -> signIn.prepareFirstFactor({ strategy: 'email_code',
//             emailAddressId }) -> signIn.attemptFirstFactor({ strategy: 'email_code', code }).
//   Sign-up (only when Clerk says the email has no account, shouldFallBackToSignUp):
//             signUp.create({ emailAddress }) -> signUp.prepareEmailAddressVerification({
//             strategy: 'email_code' }) -> signUp.attemptEmailAddressVerification({ code }).
// A complete attempt activates its session with setActive; Convex auth and the app shell then
// take over, so the screen does nothing more. Clerk's own error message (or a calm generic one)
// is shown inline; every button is disabled while a request runs. "Resend code" repeats the
// prepare step of the flow in use and "Use a different email" returns to the first step. The
// pure parts live in backend/caregiverAuth.ts. onBack (optional) returns to the welcome choice.
//
// Last modified: 2026-10-30

import { useSignIn, useSignUp } from '@clerk/expo/legacy';
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
import { PrimaryButton } from '../components/PrimaryButton';
import { TextButton } from '../components/TextButton';
import { logger } from '../logging/logger';
import { colors, GRID, ROUNDED_FONT } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';

/** Which Clerk flow the emailed code belongs to. */
type Flow = 'signIn' | 'signUp';

/** The loaded Clerk sign-in resource. */
type SignInResource = Extract<ReturnType<typeof useSignIn>, { isLoaded: true }>['signIn'];
/** The loaded Clerk sign-up resource. */
type SignUpResource = Extract<ReturnType<typeof useSignUp>, { isLoaded: true }>['signUp'];

/** Props for CaregiverSignInScreen. */
interface CaregiverSignInScreenProps {
  /** Returns to the welcome choice; the Back button is hidden without it. */
  onBack?: () => void;
}

/**
 * purpose: Ask Clerk to email a sign-in code for the email already given to signIn.create.
 * @param signIn: (SignInResource) The sign-in attempt in progress.
 * @return: (Promise<void>) Resolves once the code is sent.
 * @raises: Error when the account cannot sign in with an email code, or Clerk's error.
 */
async function sendSignInCode(signIn: SignInResource): Promise<void> {
  const emailAddressId = findEmailCodeFactorId(signIn.supportedFirstFactors);
  if (emailAddressId === null) throw new Error('No email code factor for this account');
  await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId });
}

/**
 * purpose: Start a sign-in for the email and send it a code. When Clerk reports the email has
 *          no account, start a sign-up instead and send the verification code.
 * @param signIn: (SignInResource) The sign-in resource.
 * @param signUp: (SignUpResource) The sign-up resource.
 * @param email: (string) The normalized email.
 * @return: (Promise<Flow>) The flow the code was sent for.
 * @raises: Clerk's error (or an Error) when neither flow could send a code.
 */
async function startFlow(
  signIn: SignInResource,
  signUp: SignUpResource,
  email: string,
): Promise<Flow> {
  try {
    const attempt = await signIn.create({ identifier: email });
    await sendSignInCode(attempt);
    return 'signIn';
  } catch (error) {
    if (!shouldFallBackToSignUp(error)) throw error;
  }
  await signUp.create({ emailAddress: email });
  await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
  return 'signUp';
}

/**
 * purpose: Check the code with the flow it was sent for.
 * @param flow: (Flow) The flow in use.
 * @param signIn: (SignInResource) The sign-in resource.
 * @param signUp: (SignUpResource) The sign-up resource.
 * @param code: (string) The 6-digit code.
 * @return: (Promise<string | null>) The id of the created session, or null when the attempt
 *          did not complete (for example Clerk wants a second factor or more sign-up fields).
 * @raises: Clerk's error, for example for a wrong or expired code.
 */
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

/**
 * purpose: Email and code entry that signs a caregiver in (or up) with Clerk.
 * @param props: (CaregiverSignInScreenProps) Optional onBack handler.
 * @return: (JSX.Element) The screen.
 */
export function CaregiverSignInScreen({ onBack }: CaregiverSignInScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const signInHook = useSignIn();
  const signUpHook = useSignUp();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const ready = signInHook.isLoaded && signUpHook.isLoaded;
  const awaitingCode = flow !== null;

  /**
   * purpose: Run one Clerk step with the busy flag and inline error message around it.
   * @param step: (() => Promise<void>) The step; may throw.
   * @return: (Promise<void>) Resolves when the step finished and any failure is shown.
   */
  const run = async (step: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await step();
    } catch (error) {
      logger.warning('CaregiverSignIn', `Clerk step failed: ${signInErrorMessage(error)}`);
      setMessage(signInErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  /**
   * purpose: Send the code for the typed email and move to the code step.
   * @return: (Promise<void>) Resolves when the code was sent or the failure is shown.
   */
  const handleSendCode = (): Promise<void> =>
    run(async () => {
      if (!signInHook.isLoaded || !signUpHook.isLoaded) return;
      const started = await startFlow(signInHook.signIn, signUpHook.signUp, normalizeEmail(email));
      setCode('');
      setFlow(started);
    });

  /**
   * purpose: Send the code again for the flow in use.
   * @return: (Promise<void>) Resolves when the code was sent or the failure is shown.
   */
  const handleResend = (): Promise<void> =>
    run(async () => {
      if (!signInHook.isLoaded || !signUpHook.isLoaded) return;
      if (flow === 'signIn') await sendSignInCode(signInHook.signIn);
      else await signUpHook.signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    });

  /**
   * purpose: Check the typed code and activate the session it creates.
   * @return: (Promise<void>) Resolves when signed in or the failure is shown.
   */
  const handleVerify = (): Promise<void> =>
    run(async () => {
      if (!signInHook.isLoaded || !signUpHook.isLoaded || flow === null) return;
      const sessionId = await verifyCode(
        flow,
        signInHook.signIn,
        signUpHook.signUp,
        cleanCode(code),
      );
      if (sessionId === null) {
        setMessage(SIGN_IN_INCOMPLETE_MESSAGE);
        return;
      }
      await signInHook.setActive({ session: sessionId });
    });

  /**
   * purpose: Return to the email step so another email can be used.
   * @return: (void)
   */
  const handleChangeEmail = (): void => {
    setFlow(null);
    setCode('');
    setMessage(null);
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
          {awaitingCode ? 'Check your email' : 'Caregiver sign in'}
        </Text>
        <Text style={styles.subtitle}>
          {awaitingCode
            ? `We sent a 6-digit code to ${normalizeEmail(email)}.`
            : 'Enter your email and we will send you a code.'}
        </Text>
        {awaitingCode ? (
          <TextInput
            accessibilityLabel="Email code"
            value={code}
            onChangeText={(text) => setCode(cleanCode(text))}
            placeholder="123456"
            placeholderTextColor={colors.secondaryText}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            autoFocus
            editable={!busy}
            style={[styles.input, styles.codeInput, { borderRadius: theme.cornerRadius }]}
          />
        ) : (
          <TextInput
            accessibilityLabel="Email address"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.secondaryText}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            editable={!busy}
            style={[styles.input, { borderRadius: theme.cornerRadius }]}
          />
        )}
        {message !== null && <Text style={styles.error}>{message}</Text>}
        {awaitingCode ? (
          <>
            <PrimaryButton
              label="Sign in"
              disabled={!ready || !isCompleteCode(code)}
              busy={busy}
              onPress={handleVerify}
              style={styles.button}
            />
            <TextButton label="Resend code" disabled={busy} onPress={() => void handleResend()} />
            <TextButton label="Use a different email" disabled={busy} onPress={handleChangeEmail} />
          </>
        ) : (
          <PrimaryButton
            label="Send code"
            accessibilityHint="Emails you a 6-digit sign-in code"
            disabled={!ready || !isValidEmail(email)}
            busy={busy}
            onPress={handleSendCode}
            style={styles.button}
          />
        )}
        {onBack !== undefined && <TextButton label="Back" disabled={busy} onPress={onBack} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4 * GRID,
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
    fontFamily: ROUNDED_FONT,
    fontSize: 24,
    color: colors.text,
    backgroundColor: colors.overlayMedium,
  },
  codeInput: { fontFamily: 'Menlo', fontSize: 34, fontWeight: '600', textAlign: 'center' },
  error: { fontSize: 18, textAlign: 'center', color: colors.seriousForeground },
  button: { maxWidth: 420, width: '100%' },
});
