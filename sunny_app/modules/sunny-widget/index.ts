import { requireNativeModule } from 'expo';

export type FlushResult = 'clean' | 'pending' | 'unauthorized' | 'noCredentials';

export interface SunnyWidgetBridge {
  storedSiteUrl(): string | null;
  setCredentials(token: string, siteUrl: string): Promise<void>;
  clearCredentials(): Promise<boolean>;
  reloadTimelines(): void;
  flushPresses(): Promise<FlushResult>;
}

export default requireNativeModule<SunnyWidgetBridge>('SunnyWidget');
