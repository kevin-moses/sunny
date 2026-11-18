import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { PALETTE } from './colors';

const STORAGE_KEY = 'sunny.theme';

export const BODY_FONT_RANGE: readonly [number, number] = [14, 24];
export const BUTTON_FONT_RANGE: readonly [number, number] = [15, 28];
export const CORNER_RADIUS_RANGE: readonly [number, number] = [4, 32];

interface ThemeSettings {
  accentColorIndex: number;
  bodyFontSize: number;
  buttonFontSize: number;
  cornerRadius: number;
}

const DEFAULTS: ThemeSettings = {
  accentColorIndex: 0,
  bodyFontSize: 17,
  buttonFontSize: 19,
  cornerRadius: 12,
};

interface Theme extends ThemeSettings {
  accentColor: string;
  accentColorName: string;
  setAccentColorIndex: (index: number) => void;
  setBodyFontSize: (size: number) => void;
  setButtonFontSize: (size: number) => void;
  setCornerRadius: (radius: number) => void;
  resetToDefaults: () => void;
}

const ThemeContext = createContext<Theme | null>(null);

function clamp(value: unknown, range: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range[1], Math.max(range[0], Math.round(value)));
}

function sanitizeSettings(raw: unknown): ThemeSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const index = source.accentColorIndex;
  const validIndex =
    typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < PALETTE.length;
  return {
    accentColorIndex: validIndex ? index : DEFAULTS.accentColorIndex,
    bodyFontSize: clamp(source.bodyFontSize, BODY_FONT_RANGE, DEFAULTS.bodyFontSize),
    buttonFontSize: clamp(source.buttonFontSize, BUTTON_FONT_RANGE, DEFAULTS.buttonFontSize),
    cornerRadius: clamp(source.cornerRadius, CORNER_RADIUS_RANGE, DEFAULTS.cornerRadius),
  };
}

async function loadSettings(): Promise<ThemeSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(raw === null ? null : JSON.parse(raw));
  } catch {
    return DEFAULTS;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ThemeSettings>(DEFAULTS);

  useEffect(() => {
    let active = true;
    void loadSettings().then((saved) => {
      if (active) setSettings(saved);
    });
    return () => {
      active = false;
    };
  }, []);

  const commit = useCallback((next: ThemeSettings): void => {
    setSettings(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const theme = useMemo<Theme>(() => {
    const update = (patch: Partial<ThemeSettings>): void =>
      commit(sanitizeSettings({ ...settings, ...patch }));
    return {
      ...settings,
      accentColor: PALETTE[settings.accentColorIndex].color,
      accentColorName: PALETTE[settings.accentColorIndex].name,
      setAccentColorIndex: (index) => update({ accentColorIndex: index }),
      setBodyFontSize: (size) => update({ bodyFontSize: size }),
      setButtonFontSize: (size) => update({ buttonFontSize: size }),
      setCornerRadius: (radius) => update({ cornerRadius: radius }),
      resetToDefaults: () => commit(DEFAULTS),
    };
  }, [settings, commit]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) throw new Error('useTheme must be used inside a ThemeProvider');
  return theme;
}
