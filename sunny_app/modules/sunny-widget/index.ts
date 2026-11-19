import { requireNativeModule } from 'expo';

export type FlushResult = 'clean' | 'pending' | 'unauthorized' | 'noCredentials';

export interface SunnyWidgetBridge {
  storedSiteUrl(): Promise<string | null>;
  setCredentials(token: string, siteUrl: string): Promise<void>;
  clearCredentials(): Promise<void>;
  syncSurfaces(): Promise<void>;
  flushPresses(): Promise<FlushResult>;
  unsentPresses(): Promise<unknown>;
  markPressed(pressId: string, instanceId: string, step: number, pressedAt: number): Promise<void>;
  answerPress(pressId: string): Promise<void>;
  withdrawPress(pressId: string): Promise<void>;
}

export default requireNativeModule<SunnyWidgetBridge>('SunnyWidget');
