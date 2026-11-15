// sunny_app/src/caregiver/WordingCard.tsx
//
// Purpose: The wording card in the caregiver's Chat tab: under Sunny's reply to a request that
// added or changed a task, a quiet warm translucent card showing what the senior will see and
// hear for that task, read live from the task. Two labelled lines: "On the display" (the task's
// first time and its label on one baseline, as the display's row draws them) and "Sunny says"
// (the exact sentence the display speaks at that time), with a small play button that speaks
// the sentence on this phone (useWordingPlayer) and turns into a stop button while it plays.
// A task with more than one time gets a caption under them, "Also at 8:00 PM", in the caregiver
// app's time form. A task with no time is never spoken, so its card says so and has no button.
// The card has no edit control: the caregiver changes the wording by telling Sunny. VoiceOver
// reads the card as "On the display: <time> <label>. Sunny says: <sentence>", then the other
// times; the button is "Play what Sunny says" or "Stop". When the sentence could not be played,
// the card says so, the failure is part of what VoiceOver reads for the card, and it is
// announced once when it happens.
//
// Last modified: 2026-11-14

import { SymbolView } from 'expo-symbols';
import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';
import {
  NOT_SPOKEN,
  ON_DISPLAY,
  otherTimesCaption,
  SUNNY_SAYS,
  wordingSpeech,
  type TaskWording,
} from './format';

/** Accessibility label of the button while nothing plays. */
export const PLAY_LABEL = 'Play what Sunny says';

/** Accessibility label of the button while the sentence plays. */
export const STOP_LABEL = 'Stop';

/** Shown on the card when its sentence could not be played. */
export const PLAY_FAILED_TEXT = 'Could not play it. Check the volume and try again.';

/** Side of the button's touch target (points). */
const HIT_SIZE = 44;

/** Diameter of the button's visible circle (points). */
const BUTTON_SIZE = 32;

/** Opacity of the accent tint behind the button. */
const BUTTON_TINT = '33';

/** Props of WordingCard. */
interface WordingCardProps {
  wording: TaskWording;
  /** Whether this card's sentence is playing. */
  playing: boolean;
  /** Whether this card's last play failed. */
  failed: boolean;
  /** Play the sentence, or stop it when it plays. */
  onToggle: () => void;
}

/**
 * purpose: Render one wording card (see the file header); announces a failed play once.
 * @param props: (WordingCardProps) The task's wording, whether it plays or failed, and the
 *        button's action.
 * @return: (JSX.Element) The card.
 */
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
  // Same free space on the right as Sunny's reply above it.
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
