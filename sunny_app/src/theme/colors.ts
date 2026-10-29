// sunny_app/src/theme/colors.ts
//
// Purpose: Sunny's fixed design tokens: the warm app background, the five-color accent
// palette the user can pick from, neutral text/card/separator colors, the serious
// (error, end-call) and moderate (warning) status colors, and the rounded system font.
// The app is light-only, so there is one value per token.
//
// Last modified: 2026-10-28

/** Fixed app background color; not user-selectable. */
export const BACKGROUND = '#FAE6CC';

/** One selectable accent color. */
interface PaletteEntry {
  name: string;
  color: string;
}

/** The five warm accent colors in Sunny's design palette (index 0 is the default). */
export const PALETTE: readonly PaletteEntry[] = [
  { name: 'Orange', color: '#FA8539' },
  { name: 'Golden', color: '#FABF39' },
  { name: 'Amber', color: '#FAA739' },
  { name: 'Deep Orange', color: '#FA6339' },
  { name: 'Yellow', color: '#FADA54' },
];

/** Neutral and status colors shared by the senior UI and the voice UI. */
export const colors = {
  /** Primary text; near-black for high contrast on the cream background. */
  text: '#111111',
  /** Secondary text (labels, times). */
  secondaryText: '#4D4D4D',
  /** Text and icons drawn on an accent-colored fill. */
  onAccent: '#000000',
  /** Pure black, for body text in the transcript and for shadows. */
  ink: '#000000',
  /** Opaque white, for cards on the settings sheet. */
  surface: '#FFFFFF',
  /** Translucent white over the background (the DEV pill). */
  overlayStrong: 'rgba(255,255,255,0.85)',
  /** Lighter translucent white over the background (the join-code field). */
  overlayMedium: 'rgba(255,255,255,0.6)',
  /** Faint translucent black over the background (the going-out strip). */
  overlayFaint: 'rgba(0,0,0,0.06)',
  /** Neutral card / control background (asset catalog bg2). */
  card: '#F3F3F1',
  /** Hairline separator (asset catalog separator1). */
  separator: '#DBDBD8',
  /** Completed-task check mark; darker than system green for contrast. */
  success: '#1E7B34',
  /** Error / end-call foreground (asset catalog fgSerious). */
  seriousForeground: '#DB1B06',
  /** Error / end-call background (asset catalog bgSerious). */
  seriousBackground: '#FAE6E6',
  /** Error border (asset catalog separatorSerious). */
  seriousSeparator: '#FDC2BC',
  /** Warning foreground (asset catalog fgModerate). */
  moderateForeground: '#A65006',
  /** Warning background (asset catalog bgModerate). */
  moderateBackground: '#FAEDD1',
  /** Warning border (asset catalog separatorModerate). */
  moderateSeparator: '#FBD7A0',
} as const;

/** The iOS rounded system font. */
export const ROUNDED_FONT = 'ui-rounded';

/** The grid spacing unit (points) used for layout. */
export const GRID = 4;
