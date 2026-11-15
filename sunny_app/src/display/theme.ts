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

export const ink = {
  paper: '#F7F4EC',
  ink: '#121212',
  grey: '#6B6B6B',
  bezel: '#1B1B1B',
  keyPressed: '#D9D5CB',
  keyEdge: '#9C978B',
} as const;

export const TAB_SEPARATOR = '  ·  ';

export const CANVAS = { width: 1194, height: 834 } as const;

const FAMILY = {
  serifBold: 'Literata_700Bold',
  serifMedium: 'Literata_500Medium',
  regular: 'AtkinsonHyperlegibleNext_400Regular',
  medium: 'AtkinsonHyperlegibleNext_500Medium',
  semiBold: 'AtkinsonHyperlegibleNext_600SemiBold',
  bold: 'AtkinsonHyperlegibleNext_700Bold',
  extraBold: 'AtkinsonHyperlegibleNext_800ExtraBold',
} as const;

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
  voiceTitle: textStyle(FAMILY.extraBold, 64, 110),
  answer: textStyle(FAMILY.semiBold, 44, 125),
  answerWide: textStyle(FAMILY.semiBold, 52, 125),
  key: textStyle(FAMILY.extraBold, 40, 120),
  keyStatus: textStyle(FAMILY.bold, 26, 125),
} as const;

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
