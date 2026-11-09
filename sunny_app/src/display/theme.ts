// sunny_app/src/display/theme.ts
//
// Purpose: Design tokens of the home display's black-and-white e-ink look (Figma file
// "Sunny Caregiver App", page "Senior Display Mockups"): the paper, ink and grey colors, the
// fixed 1194 x 834 design canvas every screen is drawn on, the text styles (`font`: Literata
// for the orientation header, Atkinson Hyperlegible Next for everything else) and the hook that
// loads those fonts. Line heights are the design's percentages turned into points. Only two greys
// exist besides ink so every state still reads on a 1-bit panel.
//
// Last modified: 2026-11-09

import {
  AtkinsonHyperlegibleNext_400Regular,
  AtkinsonHyperlegibleNext_500Medium,
  AtkinsonHyperlegibleNext_600SemiBold,
  AtkinsonHyperlegibleNext_700Bold,
  AtkinsonHyperlegibleNext_800ExtraBold,
} from '@expo-google-fonts/atkinson-hyperlegible-next';
import { Literata_500Medium, Literata_700Bold } from '@expo-google-fonts/literata';
import { useFonts } from 'expo-font';
import type { TextStyle } from 'react-native';

/** Colors of the e-ink look: paper, near-black ink, the grey of finished items, and the bezel. */
export const ink = {
  paper: '#F7F4EC',
  ink: '#121212',
  /** Finished items (time, label and check); still black after a 1-bit threshold of 160. */
  grey: '#6B6B6B',
  /** The device body around the panel and behind the Done and Talk keys. */
  bezel: '#1B1B1B',
  /** A key while it is held down. */
  keyPressed: '#D9D5CB',
  /** The lower edge that makes a key look raised. */
  keyEdge: '#9C978B',
} as const;

/** The size (points) every display screen is designed at; the screen scales it to fit. */
export const CANVAS = { width: 1194, height: 834 } as const;

/** The loaded font families, one per weight. */
const FAMILY = {
  serifBold: 'Literata_700Bold',
  serifMedium: 'Literata_500Medium',
  regular: 'AtkinsonHyperlegibleNext_400Regular',
  medium: 'AtkinsonHyperlegibleNext_500Medium',
  semiBold: 'AtkinsonHyperlegibleNext_600SemiBold',
  bold: 'AtkinsonHyperlegibleNext_700Bold',
  extraBold: 'AtkinsonHyperlegibleNext_800ExtraBold',
} as const;

/**
 * purpose: A text style from a family, a size and the design's line height percentage.
 * @param fontFamily: (string) One of FAMILY.
 * @param fontSize: (number) Points.
 * @param lineHeightPercent: (number) Line height as a percentage of the size.
 * @return: (TextStyle & { lineHeight: number }) The style, in ink, with its line height set.
 */
function textStyle(
  fontFamily: string,
  fontSize: number,
  lineHeightPercent: number,
): TextStyle & { lineHeight: number } {
  return {
    fontFamily,
    fontSize,
    lineHeight: Math.round((fontSize * lineHeightPercent) / 100),
    color: ink.ink,
  };
}

/** The display's text styles, named for where the design uses them. */
export const font = {
  header: textStyle(FAMILY.serifBold, 72, 105),
  date: textStyle(FAMILY.serifMedium, 32, 120),
  tab: textStyle(FAMILY.extraBold, 30, 120),
  nextLabel: textStyle(FAMILY.bold, 30, 120),
  taskTitle: textStyle(FAMILY.extraBold, 72, 110),
  stepTitle: textStyle(FAMILY.extraBold, 64, 110),
  clearTitle: textStyle(FAMILY.extraBold, 56, 115),
  taskDetail: textStyle(FAMILY.regular, 40, 120),
  prompt: textStyle(FAMILY.bold, 34, 120),
  keycap: textStyle(FAMILY.extraBold, 32, 120),
  nextTitle: textStyle(FAMILY.extraBold, 44, 115),
  nextTime: textStyle(FAMILY.bold, 36, 120),
  rowTime: textStyle(FAMILY.bold, 34, 120),
  rowLabel: textStyle(FAMILY.semiBold, 36, 120),
  rowLabelNow: textStyle(FAMILY.extraBold, 36, 120),
  stripLead: textStyle(FAMILY.extraBold, 30, 130),
  stripItems: textStyle(FAMILY.medium, 30, 130),
  key: textStyle(FAMILY.extraBold, 40, 120),
  keyStatus: textStyle(FAMILY.bold, 26, 125),
} as const;

/**
 * purpose: Load the display's fonts.
 * @return: (boolean) True once the fonts loaded, or failed to load (the screen then falls back
 *          to the system font rather than staying blank).
 */
export function useDisplayFonts(): boolean {
  const [loaded, error] = useFonts({
    Literata_500Medium,
    Literata_700Bold,
    AtkinsonHyperlegibleNext_400Regular,
    AtkinsonHyperlegibleNext_500Medium,
    AtkinsonHyperlegibleNext_600SemiBold,
    AtkinsonHyperlegibleNext_700Bold,
    AtkinsonHyperlegibleNext_800ExtraBold,
  });
  return loaded || error !== null;
}
