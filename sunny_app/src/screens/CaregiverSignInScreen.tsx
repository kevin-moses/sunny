// sunny_app/src/screens/CaregiverSignInScreen.tsx
//
// Purpose: Caregiver sign-in with a Clerk email code, in two steps: the email (EmailStep), then
// the 6-digit code Clerk mails to it (CodeStep). It uses Clerk's classic (legacy) hooks from
// '@clerk/expo/legacy':
//   Sign-in:  signIn.create({ identifier }) -> signIn.prepareFirstFactor({ strategy: 'email_code',
//             emailAddressId }) -> signIn.attemptFirstFactor({ strategy: 'email_code', code }).
//   Sign-up (only when Clerk says the email has no account, shouldFallBackToSignUp):
//             signUp.create({ emailAddress }) -> signUp.prepareEmailAddressVerification({
//             strategy: 'email_code' }) -> signUp.attemptEmailAddressVerification({ code }).
// A complete attempt activates its session with setActive; Convex auth and the app shell then
// take over, so the screen does nothing more. Clerk's own error message (or a calm generic one)
// is shown inline; every button is disabled while a request runs. "Resend code" repeats the
// send step of the flow in use (sendCode) and "Use a different email" returns to the first step.
// The pure parts live in backend/caregiverAuth.ts. onBack (optional) returns to the welcome
// choice.
//
// Last modified: 2026-10-31

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

/** Which Clerk flow the emailed code belongs to. */
type Flow = 'signIn' | 'signUp';

/** The loaded Clerk sign-in resource. */
type SignInResource = Extract<ReturnType<typeof useSignIn>, { isLoaded: true }>['signIn'];
/** The loaded Clerk sign-up resource. */
type SignUpResource = Extract<ReturnType<typeof useSignUp>, { isLoaded: true }>['signUp'];
/** Activates the session a complete attempt created. */
type SetActive = Extract<ReturnType<typeof useSignIn>, { isLoaded: true }>['setActive'];

/** Props for CaregiverSignInScreen. */
interface CaregiverSignInScreenProps {
  /** Returns to the welcome choice; the Back button is hidden without it. */
  onBack?: () => void;
}

/**
 * purpose: Ask Clerk to email the code of a flow: the sign-in first factor or the sign-up
 *          email verification.
 * @param flow: (Flow) The flow the code is for.
 * @param signIn: (SignInResource) The sign-in attempt in progress (used for the signIn flow).
 * @param signUp: (SignUpResource) The sign-up attempt in progress (used for the signUp flow).
 * @return: (Promise<void>) Resolves once the code is sent.
 * @raises: Error when the account cannot sign in with an email code, or Clerk's error.
 */
async function sendCode(flow: Flow, signIn: SignInResource, signUp: SignUpResource): Promise<void> {
  if (flow === 'signUp') {
    await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    return;
  }
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
    await sendCode('signIn', attempt, signUp);
    return 'signIn';
  } catch (error) {
    if (!shouldFallBackToSignUp(error)) throw error;
  }
  await signUp.create({ emailAddress: email });
  await sendCode('signUp', signIn, signUp);
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

/** Props for EmailStep. */
interface EmailStepProps {
  email: string;
  onChangeEmail: (text: string) => void;
  message: string | null;
  busy: boolean;
  /** Clerk has loaded, so a code can be requested. */
  ready: boolean;
  onSend: () => void;
}

/**
 * purpose: The first step: the email field and the "Send code" button.
 * @param props: (EmailStepProps) The email, its change handler, the message, the busy and ready
 *        flags and the send handler.
 * @return: (JSX.Element) The step.
 */
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

/** Props for CodeStep. */
interface CodeStepProps {
  code: string;
  onChangeCode: (text: string) => void;
  message: string | null;
  busy: boolean;
  /** Clerk has loaded, so the code can be checked. */
  ready: boolean;
  onVerify: () => void;
  onResend: () => void;
  onChangeEmail: () => void;
}

/**
 * purpose: The second step: the code field, "Sign in", "Resend code" and "Use a different
 *          email".
 * @param props: (CodeStepProps) The code, its change handler, the message, the busy and ready
 *        flags and the verify, resend and change-email handlers.
 * @return: (JSX.Element) The step.
 */
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

/**
 * purpose: Email and code entry that signs a caregiver in (or up) with Clerk.
 * @param props: (CaregiverSignInScreenProps) Optional onBack handler.
 * @return: (JSX.Element) The screen.
 */
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

  /**
   * purpose: Send the code for the typed email and move to the code step.
   * @return: (Promise<void>) Resolves when the code was sent or the failure is shown.
   */
  const handleSendCode = (): Promise<void> =>
    run(async () => {
      if (clerk === null) return;
      const started = await startFlow(clerk.signIn, clerk.signUp, normalizeEmail(email));
      setCode('');
      setFlow(started);
    });

  /**
   * purpose: Send the code again for the flow in use.
   * @return: (Promise<void>) Resolves when the code was sent or the failure is shown.
   */
  const handleResend = (): Promise<void> =>
    run(async () => {
      if (clerk === null || flow === null) return;
      await sendCode(flow, clerk.signIn, clerk.signUp);
    });

  /**
   * purpose: Check the typed code and activate the session it creates.
   * @return: (Promise<void>) Resolves when signed in or the failure is shown.
   */
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

  /**
   * purpose: Return to the email step so another email can be used.
   * @return: (void)
   */
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
