import { requireNativeModule } from 'expo';

export type FlushResult = 'clean' | 'pending' | 'unauthorized' | 'noCredentials';

export interface UnsentPress {
  id: string;
  instanceId: string;
  step: number;
  pressedAt: number;
}

export interface SunnyWidgetBridge {
  storedSiteUrl(): string | null;
  setCredentials(token: string, siteUrl: string): Promise<void>;
  clearCredentials(): Promise<boolean>;
  syncSurfaces(): Promise<void>;
  flushPresses(): Promise<FlushResult>;
  unsentPresses(): unknown;
  markPressed(pressId: string, instanceId: string, step: number, pressedAt: number): Promise<void>;
  answerPress(pressId: string): Promise<void>;
  withdrawPress(pressId: string): Promise<void>;
}

export default requireNativeModule<SunnyWidgetBridge>('SunnyWidget');
