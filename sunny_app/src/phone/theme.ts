import {
  AtkinsonHyperlegibleNext_500Medium,
  AtkinsonHyperlegibleNext_600SemiBold,
  AtkinsonHyperlegibleNext_700Bold,
  AtkinsonHyperlegibleNext_800ExtraBold,
} from '@expo-google-fonts/atkinson-hyperlegible-next';
import { Literata_700Bold } from '@expo-google-fonts/literata';
import { useFonts } from 'expo-font';
import type { BoxShadowValue, TextStyle } from 'react-native';

import { ink } from '../display/theme';

export const paper = {
  paper: ink.paper,
  ink: ink.ink,
  grey: ink.grey,
  panel: ink.keyPressed,
  now: '#FABF39',
  talk: '#FA8539',
  talkGlow: '#F0620F',
} as const;

export function withAlpha(hex: string, alpha: number): string {
  const byte = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${byte.toUpperCase()}`;
}

export const layout = {
  side: 24,
  gap: 14,
  belowSafeTop: 8,
  columnTop: 44,
  offlineTop: 8,
  aboveSafeBottom: 18,
  tagRow: 38,
  headline: 200,
  headlineGap: 8,
  doneSlot: 122,
  key: 96,
  keyRadius: 24,
  undoGap: 16,
  undoWidth: 150,
  undoHeight: 58,
  undoRadius: 18,
  outline: 3,
  row: 38,
  rowRadius: 6,
  mark: 26,
  timeColumn: 98,
  talk: 64,
} as const;

export interface TextRole {
  style: TextStyle & { fontSize: number; lineHeight: number };
  maxScale: number;
}

const FAMILY = {
  serif: 'Literata_700Bold',
  medium: 'AtkinsonHyperlegibleNext_500Medium',
  semiBold: 'AtkinsonHyperlegibleNext_600SemiBold',
  bold: 'AtkinsonHyperlegibleNext_700Bold',
  extraBold: 'AtkinsonHyperlegibleNext_800ExtraBold',
} as const;

function role(
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  maxScale: number,
): TextRole {
  return { style: { fontFamily, fontSize, lineHeight, color: paper.ink }, maxScale };
}

export const roles = {
  tag: role(FAMILY.extraBold, 20, 24, 1.4),
  step: role(FAMILY.bold, 20, 24, 1.4),
  headline: role(FAMILY.serif, 40, 44, 1.2),
  detail: role(FAMILY.medium, 22, 28, 1.3),
  undoLine: role(FAMILY.serif, 28, 34, 1.2),
  undoNote: role(FAMILY.bold, 22, 28, 1.3),
  doneKey: role(FAMILY.bold, 40, 48, 1.2),
  earlyKey: role(FAMILY.bold, 36, 44, 1.2),
  keyStatus: role(FAMILY.bold, 28, 34, 1.2),
  next: role(FAMILY.bold, 22, 28, 1.3),
  rowTime: role(FAMILY.bold, 22, 28, 1.3),
  rowLabel: role(FAMILY.semiBold, 22, 28, 1.3),
  rowStrong: role(FAMILY.extraBold, 22, 28, 1.3),
  talk: role(FAMILY.extraBold, 28, 34, 1.2),
  offline: role(FAMILY.bold, 20, 24, 1.3),
} as const;

export function cappedScale(fontScale: number, textRole: TextRole): number {
  return Math.min(fontScale, textRole.maxScale);
}

function shadow(
  color: string,
  offsetY: number,
  blurRadius: number,
  spreadDistance = 0,
): BoxShadowValue {
  return { offsetX: 0, offsetY, blurRadius, spreadDistance, color };
}

const INK_SOFT = shadow(withAlpha(paper.ink, 0.25), 3, 6);

export const shadows = {
  done: [shadow(paper.now, 14, 30, 2), INK_SOFT],
  donePressed: [shadow(withAlpha(paper.now, 0.9), 4, 12), INK_SOFT],
  early: [shadow(withAlpha(paper.ink, 0.2), 8, 20), shadow(withAlpha(paper.ink, 0.25), 2, 4)],
  undo: [shadow(withAlpha(paper.ink, 0.22), 5, 12), shadow(withAlpha(paper.ink, 0.25), 2, 3)],
  talk: [
    shadow(withAlpha(paper.talkGlow, 0.85), 10, 24, 1),
    shadow(withAlpha(paper.talkGlow, 0.45), 2, 4),
  ],
  talkPressed: [
    shadow(withAlpha(paper.talkGlow, 0.9), 4, 12),
    shadow(withAlpha(paper.talkGlow, 0.45), 2, 4),
  ],
} as const satisfies Record<string, readonly BoxShadowValue[]>;

export function usePhoneFonts(): boolean {
  const [loaded, error] = useFonts({
    Literata_700Bold,
    AtkinsonHyperlegibleNext_500Medium,
    AtkinsonHyperlegibleNext_600SemiBold,
    AtkinsonHyperlegibleNext_700Bold,
    AtkinsonHyperlegibleNext_800ExtraBold,
  });
  return loaded || error !== null;
}
