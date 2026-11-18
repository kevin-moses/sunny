import type { ReactElement } from 'react';

import { PrimaryButton } from '../components/PrimaryButton';
import { useVoice } from './voiceContext';

export function TalkButton(): ReactElement {
  const { connect, connectionState } = useVoice();
  return (
    <PrimaryButton
      label="Talk to Sunny"
      busy={connectionState === 'connecting'}
      busyLabel="Connecting"
      accessibilityLabel="Talk to Sunny"
      accessibilityHint="Double-tap to connect and start speaking"
      onPress={connect}
    />
  );
}
