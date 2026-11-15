import { useState } from 'react';

import { useDiscardNotificationTaps } from '../notifications/push';
import { CaregiverSignInScreen } from './CaregiverSignInScreen';
import { PairingScreen } from './PairingScreen';
import { WelcomeScreen } from './WelcomeScreen';

type SignedOutScreen = 'welcome' | 'caregiver' | 'device';

export function SignedOutFlow() {
  const [screen, setScreen] = useState<SignedOutScreen>('welcome');
  useDiscardNotificationTaps();
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
