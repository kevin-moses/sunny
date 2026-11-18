export const BACKGROUND = '#FAE6CC';

interface PaletteEntry {
  name: string;
  color: string;
}

export const PALETTE: readonly PaletteEntry[] = [
  { name: 'Orange', color: '#FA8539' },
  { name: 'Golden', color: '#FABF39' },
  { name: 'Amber', color: '#FAA739' },
  { name: 'Deep Orange', color: '#FA6339' },
  { name: 'Yellow', color: '#FADA54' },
];

export const colors = {
  text: '#111111',
  secondaryText: '#4D4D4D',
  onAccent: '#000000',
  ink: '#000000',
  surface: '#FFFFFF',
  overlayStrong: 'rgba(255,255,255,0.85)',
  overlayMedium: 'rgba(255,255,255,0.6)',
  overlayFaint: 'rgba(0,0,0,0.06)',
  overlayInk: 'rgba(0,0,0,0.9)',
  card: '#F3F3F1',
  separator: '#DBDBD8',
  success: '#1E7B34',
  seriousForeground: '#DB1B06',
  seriousBackground: '#FAE6E6',
  seriousSeparator: '#FDC2BC',
  moderateForeground: '#A65006',
  moderateBackground: '#FAEDD1',
  moderateSeparator: '#FBD7A0',
} as const;

export const statusTones = {
  serious: {
    foreground: colors.seriousForeground,
    background: colors.seriousBackground,
    separator: colors.seriousSeparator,
  },
  moderate: {
    foreground: colors.moderateForeground,
    background: colors.moderateBackground,
    separator: colors.moderateSeparator,
  },
} as const;

export const ROUNDED_FONT = 'ui-rounded';

export const GRID = 4;
