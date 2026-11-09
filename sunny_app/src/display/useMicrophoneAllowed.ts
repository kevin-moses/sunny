// sunny_app/src/display/useMicrophoneAllowed.ts
//
// Purpose: Whether the home display may use the microphone. The display asks for microphone
// permission as soon as it opens (while the family is setting it up), so the senior's first
// Talk press does not meet an iOS permission dialog. It asks again each time the app comes
// back to the foreground, which picks up a permission turned on in Settings meanwhile; iOS
// shows the dialog only while the answer is undecided. Uses expo-audio's recording
// permission, the same microphone permission LiveKit uses.
//
// Last modified: 2026-11-09

import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

/**
 * purpose: Follow the microphone permission.
 * @return: (boolean | null) True when granted, false when refused, null until known (or when
 *          it could not be read; Talk then tries and LiveKit reports any failure).
 */
export function useMicrophoneAllowed(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    /**
     * purpose: Ask for (or read) the permission and store the answer.
     * @return: (void)
     */
    const check = (): void => {
      requestRecordingPermissionsAsync()
        .then((response) => {
          if (live) setAllowed(response.granted);
        })
        .catch((error: unknown) => {
          logger.warning(
            'Voice',
            `Could not read the microphone permission: ${errorMessage(error)}`,
          );
        });
    };
    check();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return allowed;
}
