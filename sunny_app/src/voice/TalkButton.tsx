// sunny_app/src/voice/TalkButton.tsx
//
// Purpose: The Talk button, one large full-width button that starts a voice session with
// Sunny. A thin wrapper over PrimaryButton that shows "Talk to Sunny", or a spinner and
// "Connecting" while the session is being established. Accessibility: at least 60pt tall,
// label "Talk to Sunny", hint "Double-tap to connect and start speaking".
//
// Last modified: 2026-10-28

import type { ReactElement } from 'react';

import { PrimaryButton } from '../components/PrimaryButton';
import { useVoice } from './voiceContext';

/**
 * purpose: Render the Talk button wired to useVoice().connect().
 * @return: (ReactElement) the button
 */
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
