// sunny_app/src/screens/DevSettingsSheet.tsx
//
// Purpose: Developer settings sheet (opened from the DEV pill in debug builds): pick the
// accent color, adjust body text, button text and corner radius with live previews
// (+/- steppers; no slider package is installed), reset to defaults, and unpair the
// device so it can be paired again with a new code.
//
// Last modified: 2026-10-28

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { unpair } from '../backend/pairing';
import { colors, PALETTE, ROUNDED_FONT } from '../theme/colors';
import {
  BODY_FONT_RANGE,
  BUTTON_FONT_RANGE,
  CORNER_RADIUS_RANGE,
  useTheme,
} from '../theme/ThemeProvider';

/** Props for Stepper. */
interface StepperProps {
  title: string;
  value: number;
  range: readonly [number, number];
  step: number;
  onChange: (value: number) => void;
}

/**
 * purpose: A labelled -/+ control standing in for a slider.
 * @param props: (StepperProps) Title, current value, [min, max], step and change handler.
 * @return: (JSX.Element) The control.
 */
function Stepper({ title, value, range, step, onChange }: StepperProps) {
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
      <Text style={styles.rowTitle}>{title}</Text>
      <Text style={styles.value}>{value}pt</Text>
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
 * purpose: The dev settings sheet content.
 * @param props: ({ onClose: () => void }) Called to dismiss the sheet.
 * @return: (JSX.Element) The sheet.
 */
export function DevSettingsSheet({ onClose }: { onClose: () => void }) {
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
