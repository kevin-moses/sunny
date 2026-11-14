// sunny_app/src/screens/SignedOutFlow.tsx
//
// Purpose: What a signed-out user sees: the welcome choice, which leads to the caregiver email
// code sign-in (CaregiverSignInScreen) or to device pairing (PairingScreen), each with a way
// back. While it is mounted every notification tap is discarded (useDiscardNotificationTaps),
// the launch tap included, so a tap made while signed out never runs after sign-in or pairing:
// it would otherwise start a voice session on a newly paired device or claim a task when the
// caregiver app mounts later. Moved out of App.tsx so it can be tested on its own.
//
// Last modified: 2026-11-14

import { useState } from 'react';

import { useDiscardNotificationTaps } from '../notifications/push';
import { CaregiverSignInScreen } from './CaregiverSignInScreen';
import { PairingScreen } from './PairingScreen';
import { WelcomeScreen } from './WelcomeScreen';

/** The screens a signed-out user can move between. */
type SignedOutScreen = 'welcome' | 'caregiver' | 'device';

/**
 * purpose: The signed-out flow: the welcome choice, which leads to the caregiver sign-in or to
 *          device pairing, each with a way back. Discards notification taps while mounted.
 * @return: (JSX.Element) The current signed-out screen.
 */
export function SignedOutFlow() {
  const [screen, setScreen] = useState<SignedOutScreen>('welcome');
  useDiscardNotificationTaps();
  /**
   * purpose: Return to the welcome choice.
   * @return: (void) Nothing.
   */
  const back = (): void => setScreen('welcome');
  if (screen === 'caregiver') return <CaregiverSignInScreen onBack={back} />;
  if (screen === 'device') return <PairingScreen onBack={back} />;
  return (
    <WelcomeScreen
      onCaregiver={() => setScreen('caregiver')}
      onSeniorDevice={() => setScreen('device')}
    />
  );
}
