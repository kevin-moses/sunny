import AsyncStorage from '@react-native-async-storage/async-storage';

import { errorMessage } from '../errors';
import { logger } from '../logging/logger';

export const LEGACY_QUEUE_KEYS = ['sunny.pendingConfirms.v1', 'sunny.pendingConfirms.v1.corrupt'];

export async function dropLegacyPressQueue(): Promise<void> {
  try {
    const stored = await AsyncStorage.multiGet(LEGACY_QUEUE_KEYS);
    const found = stored.filter(([, value]) => value !== null);
    if (found.length === 0) return;
    logger.error('PressLog', 'Dropped the press queue an older version of the app left behind', {
      entries: found.map(([key, value]) => ({ key, value })),
    });
    await AsyncStorage.multiRemove(LEGACY_QUEUE_KEYS);
  } catch (e) {
    logger.warning('PressLog', `Could not drop the older press queue: ${errorMessage(e)}`);
  }
}
