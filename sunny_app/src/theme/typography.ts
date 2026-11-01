// sunny_app/src/theme/typography.ts
//
// Purpose: The caregiver app's text scale from the design (Title, Subtitle, Section, Headline,
// Body, Body Strong, Callout, Button, Caption). Every style shares one base (the rounded font
// in the primary text color) and adds its own size, weight and spacing; callers override color
// per use.
//
// Last modified: 2026-10-31

import { StyleSheet } from 'react-native';

import { colors, ROUNDED_FONT } from './colors';

/** What every text style starts from. */
const base = { fontFamily: ROUNDED_FONT, color: colors.text } as const;

/** Text styles keyed by their design name. */
export const type = StyleSheet.create({
  title: { ...base, fontSize: 34, lineHeight: 40, fontWeight: '700' },
  subtitle: {
    ...base,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
    color: colors.secondaryText,
  },
  section: {
    ...base,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.secondaryText,
  },
  headline: { ...base, fontSize: 18, lineHeight: 24, fontWeight: '700' },
  body: { ...base, fontSize: 17, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { ...base, fontSize: 17, lineHeight: 24, fontWeight: '700' },
  callout: { ...base, fontSize: 15, lineHeight: 20, fontWeight: '500' },
  button: { ...base, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  caption: { ...base, fontSize: 12, lineHeight: 16, fontWeight: '600' },
});
