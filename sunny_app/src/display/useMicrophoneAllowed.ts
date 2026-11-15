import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

export function useMicrophoneAllowed(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
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
