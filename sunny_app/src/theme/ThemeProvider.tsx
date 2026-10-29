// sunny_app/src/theme/ThemeProvider.tsx
//
// Purpose: Runtime-adjustable design parameters for the Sunny UI: accent color, body and
// button font sizes, and corner radius. Values are persisted in AsyncStorage when changed,
// clamped to their allowed ranges, and can be reset to defaults. Read them with useTheme();
// the dev settings sheet changes them.
//
// Last modified: 2026-10-28

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

/** Allowed ranges for the numeric settings: [min, max]. */
export const BODY_FONT_RANGE: readonly [number, number] = [14, 24];
export const BUTTON_FONT_RANGE: readonly [number, number] = [15, 28];
export const CORNER_RADIUS_RANGE: readonly [number, number] = [4, 32];

/** The persisted, user-adjustable settings. */
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

/** What useTheme() returns: current values, derived colors and setters. */
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

/**
 * purpose: Clamp a number into a range, falling back when it is not a finite number.
 * @param value: (unknown) The candidate value.
 * @param range: (readonly [number, number]) Allowed [min, max].
 * @param fallback: (number) Value used when `value` is not a finite number.
 * @return: (number) The clamped, rounded value.
 */
function clamp(value: unknown, range: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range[1], Math.max(range[0], Math.round(value)));
}

/**
 * purpose: Turn arbitrary stored data into valid settings, using defaults for bad fields.
 * @param raw: (unknown) A parsed JSON value.
 * @return: (ThemeSettings) Valid settings.
 */
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

/**
 * purpose: Load the saved settings from AsyncStorage.
 * @return: (Promise<ThemeSettings>) Saved settings, or defaults when none or unreadable.
 */
async function loadSettings(): Promise<ThemeSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(raw === null ? null : JSON.parse(raw));
  } catch {
    return DEFAULTS;
  }
}

/**
 * purpose: Provide the theme to the component tree and persist changes.
 * @param props: ({ children: ReactNode }) The subtree that reads useTheme().
 * @return: (JSX.Element) The provider.
 */
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

  /**
   * purpose: Apply new settings and save them.
   * @param next: (ThemeSettings) The settings to use from now on.
   * @return: (void)
   */
  const commit = useCallback((next: ThemeSettings): void => {
    setSettings(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const theme = useMemo<Theme>(() => {
    /**
     * purpose: Merge a partial change into the settings, sanitize it and save it.
     * @param patch: (Partial<ThemeSettings>) the settings to change
     * @return: (void)
     */
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

/**
 * purpose: Read the current theme.
 * @return: (Theme) Current values, derived accent colors and setters.
 * @raises: Error when used outside a ThemeProvider.
 */
export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) throw new Error('useTheme must be used inside a ThemeProvider');
  return theme;
}
