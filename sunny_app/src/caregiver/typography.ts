// sunny_app/src/caregiver/typography.ts
//
// Purpose: The caregiver app's text styles from the design (Title, Subtitle, Section, Headline,
// Body, Body Strong, Callout, Button, Caption), all in the rounded font, plus the shared
// layout constants for the floating tab bar. Colors default to the primary text color; callers
// override color per use.
//
// Last modified: 2026-10-30

import { StyleSheet } from 'react-native';

import { colors, ROUNDED_FONT } from '../theme/colors';

/** Text styles keyed by their design name. */
export const type = StyleSheet.create({
  title: {
    fontFamily: ROUNDED_FONT,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    fontFamily: ROUNDED_FONT,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
    color: colors.secondaryText,
  },
  section: {
    fontFamily: ROUNDED_FONT,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.secondaryText,
  },
  headline: {
    fontFamily: ROUNDED_FONT,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
    color: colors.text,
  },
  body: {
    fontFamily: ROUNDED_FONT,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '400',
    color: colors.text,
  },
  bodyStrong: {
    fontFamily: ROUNDED_FONT,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '700',
    color: colors.text,
  },
  callout: {
    fontFamily: ROUNDED_FONT,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
    color: colors.text,
  },
  button: {
    fontFamily: ROUNDED_FONT,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.text,
  },
  caption: {
    fontFamily: ROUNDED_FONT,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: colors.text,
  },
});

/** Height (points) of the floating tab bar pill: padding 4 + tab (8 + 22 + 4 + 16 + 8) + 4. */
export const TAB_BAR_HEIGHT = 70;

/** Gap (points) between the tab bar and the bottom safe-area edge. */
export const TAB_BAR_BOTTOM_GAP = 8;

/**
 * purpose: How much room screens leave at the bottom so content clears the floating tab bar.
 * @param bottomInset: (number) The bottom safe-area inset.
 * @return: (number) Points of clearance, including a small gap above the bar.
 */
export function tabBarClearance(bottomInset: number): number {
  return TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_GAP + bottomInset + 16;
}
