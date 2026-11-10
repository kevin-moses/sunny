// sunny_app/src/screens/DevSettingsSheet.tsx
//
// Purpose: Developer settings sheet (opened from the DEV pill in debug builds; on the home
// display only by holding the pill): pick the accent color, adjust body text, button text and
// corner radius with live previews (+/- steppers; no slider package is installed), reset to
// defaults, and unpair the device so it can be paired again with a new code.
// On the home display it adds a "Home display" section: every tunable of the display's voice
// and cue behavior (display/tuning.ts) with its current value, default and allowed range, a
// stepper that keeps it inside that range, its own reset, and two test actions: "Play due cue
// now" (asks the display's cue owner, useDueCue, to play the chime and a sample prompt at the
// current rate; it refuses during a voice session or while a cue plays and says why, and
// closing the sheet stops it) and "Show sample answer" (puts a sample answer on the panel for
// the current linger time). Changes are saved on the device and apply at once
// (TuningProvider).
//
// Last modified: 2026-11-09

import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { unpair } from '../backend/pairing';
import { TUNING_KEYS, TUNING_SPECS, formatTuning } from '../display/tuning';
import { useTuningControls } from '../display/TuningProvider';
import { colors, PALETTE, ROUNDED_FONT } from '../theme/colors';
import {
  BODY_FONT_RANGE,
  BUTTON_FONT_RANGE,
  CORNER_RADIUS_RANGE,
  useTheme,
} from '../theme/ThemeProvider';

/** The sample answer shown by "Show sample answer". */
const SAMPLE_ANSWER =
  'Sarah is coming today at 2:00. She is bringing lunch, so you do not need to cook.';

/** Props for Stepper. */
interface StepperProps {
  title: string;
  value: number;
  range: readonly [number, number];
  step: number;
  onChange: (value: number) => void;
  /** Shows a value; points ("17pt") by default. */
  format?: (value: number) => string;
  /** A small line under the title, or undefined. */
  hint?: string;
}

/**
 * purpose: A labelled -/+ control standing in for a slider.
 * @param props: (StepperProps) Title, current value, [min, max], step, change handler, and an
 *        optional value format and hint line.
 * @return: (JSX.Element) The control.
 */
function Stepper({
  title,
  value,
  range,
  step,
  onChange,
  format = (v) => `${v}pt`,
  hint,
}: StepperProps) {
  const theme = useTheme();
  /**
   * purpose: Render one of the stepper's two round buttons.
   * @param label: (string) '-' or '+'
   * @param delta: (number) amount added to the value when pressed
   * @param atLimit: (boolean) true when the value is already at that end of the range
   * @return: (JSX.Element) the button
   */
  const button = (label: string, delta: number, atLimit: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label === '-' ? 'Decrease' : 'Increase'} ${title}`}
      disabled={atLimit}
      onPress={() => onChange(value + delta)}
      style={[
        styles.stepButton,
        { backgroundColor: theme.accentColor, opacity: atLimit ? 0.35 : 1 },
      ]}
    >
      <Text style={styles.stepLabel}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.stepTitle}>{title}</Text>
        {hint !== undefined && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Text style={styles.value}>{format(value)}</Text>
      {button('-', -step, value <= range[0])}
      {button('+', step, value >= range[1])}
    </View>
  );
}

/**
 * purpose: A section with a small uppercase heading and a card of rows.
 * @param props: ({ title: string, children }) The heading and the rows.
 * @return: (JSX.Element) The section.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

/**
 * purpose: The home display's tunables and test actions.
 * @return: (JSX.Element | null) The section, or null outside a TuningProvider.
 */
function DisplayTuningSection() {
  const controls = useTuningControls();
  // Closing the sheet stops a test cue that is still playing.
  const stopRef = useRef(controls?.stopTestCue);
  useEffect(() => {
    stopRef.current = controls?.stopTestCue;
  });
  useEffect(() => () => stopRef.current?.(), []);
  if (controls === null) return null;
  const { tuning, setValue, resetToDefaults, showSampleAnswer, requestTestCue, testCueResult } =
    controls;

  return (
    <Section title="Home display">
      {TUNING_KEYS.map((key) => {
        const spec = TUNING_SPECS[key];
        /**
         * purpose: Show a value of this tunable.
         * @param v: (number) The value.
         * @return: (string) The text.
         */
        const format = (v: number): string => formatTuning(key, v);
        return (
          <Stepper
            key={key}
            title={spec.label}
            value={tuning[key]}
            range={[spec.min, spec.max]}
            step={spec.step}
            onChange={(value) => setValue(key, value)}
            format={format}
            hint={`Default ${format(spec.default)}, ${format(spec.min)} to ${format(spec.max)}`}
          />
        );
      })}
      <Pressable accessibilityRole="button" onPress={requestTestCue}>
        <Text style={styles.action}>Play due cue now</Text>
      </Pressable>
      {testCueResult !== null && <Text style={styles.hint}>Last cue: {testCueResult}</Text>}
      <Pressable accessibilityRole="button" onPress={() => showSampleAnswer(SAMPLE_ANSWER)}>
        <Text style={styles.action}>Show sample answer</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={resetToDefaults}>
        <Text style={styles.destructive}>Reset display settings to defaults</Text>
      </Pressable>
    </Section>
  );
}

/**
 * purpose: The dev settings sheet content.
 * @param props: ({ display: boolean, onClose: () => void }) Whether this is the home display
 *        (adds its tunables), and the handler that dismisses the sheet.
 * @return: (JSX.Element) The sheet.
 */
export function DevSettingsSheet({ display, onClose }: { display: boolean; onClose: () => void }) {
  const theme = useTheme();

  /**
   * purpose: Unpair this device, then close the sheet.
   * @return: (Promise<void>) resolves when the device is unpaired and the sheet closed
   */
  const handleUnpair = async (): Promise<void> => {
    await unpair();
    onClose();
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Dev Settings
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close developer settings"
          onPress={onClose}
        >
          <Text style={[styles.done, { color: colors.text }]}>Done</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {display && <DisplayTuningSection />}
        <Section title="Accent Color">
          {PALETTE.map((entry, index) => {
            const selected = theme.accentColorIndex === index;
            return (
              <Pressable
                key={entry.name}
                accessibilityRole="button"
                accessibilityLabel={`${entry.name}${selected ? ', selected' : ''}`}
                accessibilityState={{ selected }}
                onPress={() => theme.setAccentColorIndex(index)}
                style={styles.row}
              >
                <View style={[styles.swatch, { backgroundColor: entry.color }]} />
                <Text style={styles.rowTitle}>{entry.name}</Text>
                {selected && <SymbolView name="checkmark" size={18} tintColor={colors.text} />}
              </Pressable>
            );
          })}
        </Section>

        <Section title="Typography">
          <Stepper
            title="Body Text"
            value={theme.bodyFontSize}
            range={BODY_FONT_RANGE}
            step={1}
            onChange={theme.setBodyFontSize}
          />
          <Text style={{ fontSize: theme.bodyFontSize, color: colors.secondaryText }}>
            Preview: Tap the button below to talk.
          </Text>
          <Stepper
            title="Button Text"
            value={theme.buttonFontSize}
            range={BUTTON_FONT_RANGE}
            step={1}
            onChange={theme.setButtonFontSize}
          />
          <View
            style={[
              styles.previewButton,
              { backgroundColor: theme.accentColor, borderRadius: theme.cornerRadius },
            ]}
          >
            <Text
              style={{ fontSize: theme.buttonFontSize, fontWeight: '600', color: colors.onAccent }}
            >
              Talk to Sunny
            </Text>
          </View>
        </Section>

        <Section title="Geometry">
          <Stepper
            title="Corner Radius"
            value={theme.cornerRadius}
            range={CORNER_RADIUS_RANGE}
            step={2}
            onChange={theme.setCornerRadius}
          />
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View
              style={[
                styles.shape,
                {
                  borderRadius: theme.cornerRadius,
                  borderColor: theme.accentColor,
                  borderWidth: 1.5,
                  backgroundColor: `${theme.accentColor}26`,
                },
              ]}
            />
            <View
              style={[
                styles.shape,
                { borderRadius: theme.cornerRadius, backgroundColor: theme.accentColor },
              ]}
            />
          </View>
        </Section>

        <Pressable accessibilityRole="button" onPress={theme.resetToDefaults} style={styles.card}>
          <Text style={styles.destructive}>Reset to Defaults</Text>
        </Pressable>

        <Section title="Pairing">
          <Pressable accessibilityRole="button" onPress={() => void handleUnpair()}>
            <Text style={styles.destructive}>Unpair this device</Text>
          </Pressable>
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.card },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  title: { fontFamily: ROUNDED_FONT, fontSize: 20, fontWeight: '700', color: colors.text },
  done: { fontSize: 18, fontWeight: '600' },
  content: { gap: 20, padding: 16 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    color: colors.secondaryText,
  },
  card: { gap: 12, padding: 14, borderRadius: 12, backgroundColor: colors.surface },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36 },
  rowTitle: { flex: 1, fontSize: 16, color: colors.text },
  stepTitle: { fontSize: 16, color: colors.text },
  rowText: { flex: 1, gap: 2 },
  hint: { fontSize: 13, color: colors.secondaryText },
  action: { textAlign: 'center', fontSize: 17, fontWeight: '600', color: colors.text },
  value: { fontSize: 16, color: colors.secondaryText, fontVariant: ['tabular-nums'] },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { fontSize: 24, fontWeight: '600', color: colors.onAccent },
  previewButton: { height: 52, alignItems: 'center', justifyContent: 'center' },
  shape: { flex: 1, height: 44 },
  destructive: {
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: colors.seriousForeground,
  },
});
