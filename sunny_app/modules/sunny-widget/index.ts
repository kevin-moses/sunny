import { requireNativeModule } from 'expo';

export type FlushResult = 'clean' | 'pending' | 'unauthorized' | 'noCredentials';

export type UndoStatus = 'stored' | 'notSaved' | 'noCredentials';

export type PressStatus = UndoStatus | 'sent';

export interface SunnyWidgetBridge {
  storedSiteUrl(): Promise<string | null>;
  setCredentials(token: string, siteUrl: string): Promise<void>;
  clearCredentials(): Promise<void>;
  syncSurfaces(): Promise<void>;
  flushPresses(): Promise<FlushResult>;
  pressLog(): Promise<unknown>;
  pressDone(instanceId: string, step: number): Promise<PressStatus>;
  pressUndo(pressId: string): Promise<UndoStatus>;
}

export default requireNativeModule<SunnyWidgetBridge>('SunnyWidget');
