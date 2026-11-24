import { SymbolView } from 'expo-symbols';
import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';
import {
  NOT_SPOKEN,
  ON_DISPLAY,
  ON_PHONE,
  otherTimesCaption,
  SUNNY_SAYS,
  wordingSpeech,
  type TaskWording,
} from './format';

export const PLAY_LABEL = 'Play what Sunny says';

export const STOP_LABEL = 'Stop';

export const PLAY_FAILED_TEXT = 'Could not play it. Check the volume and try again.';

const HIT_SIZE = 44;

const BUTTON_SIZE = 32;

const BUTTON_TINT = '33';

interface WordingCardProps {
  wording: TaskWording;
  playing: boolean;
  failed: boolean;
  onToggle: () => void;
}

export function WordingCard({ wording, playing, failed, onToggle }: WordingCardProps) {
  const { accentColor } = useTheme();
  const others = otherTimesCaption(wording);
  const label = failed ? `${wordingSpeech(wording)} ${PLAY_FAILED_TEXT}` : wordingSpeech(wording);

  useEffect(() => {
    if (failed) AccessibilityInfo.announceForAccessibility(PLAY_FAILED_TEXT);
  }, [failed]);

  return (
    <View style={styles.row}>
      <View style={styles.card}>
        <View style={styles.text} accessible accessibilityLabel={label}>
          <Text style={[type.caption, styles.heading]}>{ON_DISPLAY}</Text>
          <View style={styles.displayLine}>
            <Text style={[type.bodyStrong, styles.ink]}>{wording.time}</Text>
            <Text style={[type.body, styles.ink, styles.label]}>{wording.label}</Text>
          </View>
          {wording.screenSentence !== null && (
            <>
              <Text style={[type.caption, styles.heading, styles.secondHeading]}>{ON_PHONE}</Text>
              <Text style={[type.callout, styles.ink]}>{wording.screenSentence}</Text>
            </>
          )}
          <Text style={[type.caption, styles.heading, styles.secondHeading]}>{SUNNY_SAYS}</Text>
          <Text style={[type.callout, wording.sentence === null ? styles.muted : styles.ink]}>
            {wording.sentence ?? NOT_SPOKEN}
          </Text>
          {others !== null && (
            <Text style={[type.caption, styles.heading, styles.secondHeading]}>{others}</Text>
          )}
          {failed && <Text style={[type.caption, styles.failed]}>{PLAY_FAILED_TEXT}</Text>}
        </View>
        {wording.sentence !== null && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playing ? STOP_LABEL : PLAY_LABEL}
            accessibilityState={{ selected: playing }}
            onPress={onToggle}
            style={styles.hit}
          >
            <View style={[styles.button, { backgroundColor: `${accentColor}${BUTTON_TINT}` }]}>
              <SymbolView
                name={playing ? 'stop.fill' : 'play.fill'}
                size={14}
                tintColor={colors.ink}
              />
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingRight: 32 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: 12,
    backgroundColor: colors.overlayMedium,
  },
  text: { flex: 1 },
  heading: { color: colors.secondaryText },
  secondHeading: { paddingTop: 6 },
  displayLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  label: { flexShrink: 1 },
  ink: { color: colors.ink },
  muted: { color: colors.secondaryText },
  failed: { color: colors.seriousForeground, paddingTop: 4 },
  hit: { width: HIT_SIZE, height: HIT_SIZE, alignItems: 'center', justifyContent: 'center' },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
