// sunny_app/src/display/DisplayParts.tsx
//
// Purpose: The pieces of the home display's two carousel screens, drawn at the design canvas
// size (theme.CANVAS) in the black-and-white e-ink look:
// - DisplayCanvas: the paper page with the orientation header ("Saturday morning", date with
//   the year) and the going-out strip at the bottom, around a screen's body. DisplayMessage is
//   the plain page shown while the day loads.
// - NowBody: the 600 pt Now card on the left and the Next up card on the right. The Now card
//   shows the task to act on (title, pill description, "Taken them? Press [Done]"), the
//   overdue form ("Still to do", plus "Not sure? Press [Talk]"), one step of a multi-step
//   task with its progress boxes, or a calm clear state. A snoozed task (the senior said "not
//   yet") keeps its card, since Done still confirms it, but its tab reads "Later" instead of
//   "Now" or "Still to do", matching the due cue, which stays quiet until the reprompt. While the senior talks to Sunny, and
//   for a few minutes after, the voice card (VoiceCardView: "Listening", "Thinking", then the
//   answer as large text) takes the Next up card's place, so a waiting task stays in view on
//   the left and Done still confirms what the screen shows. With nothing waiting, the voice
//   card takes the whole body instead, because an answer of a few sentences only fits the
//   full width at a size the senior can read across the room.
// - TodayBody: today's tasks and events as rows; finished ones grey with a check, the Now task
//   boxed with a black "Now" tag.
// The drawn keycaps only point at the physical Done and Talk keys; nothing here is pressable.
// Text ignores the system text size because the canvas is a fixed page that scales as a whole.
//
// Last modified: 2026-11-09

import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';

import { clockTime } from '../day/format';
import type { DayViewData } from '../day/types';
import { doneQuestion, fullDate, taskIcon } from './model';
import type { NextItem, NowCard, TaskCard, TodayRow } from './model';
import { CANVAS, font, ink } from './theme';
import type { VoiceCard } from './voiceModel';

/** Up to this many steps get progress boxes; longer tasks show only "Step 2 of 7". */
const MAX_PROGRESS_BOXES = 5;

/** The smallest an answer's text may shrink to fit its card, as a fraction of its size. */
const ANSWER_MIN_SCALE = 0.6;

/** Lines an answer may take at its smallest: in the Next up column, and across the body. */
const ANSWER_LINES = 11;
const ANSWER_LINES_WIDE = 9;

/**
 * purpose: Text at the canvas's fixed size (system text size is ignored; the page scales).
 * @param props: (TextProps) Text props.
 * @return: (JSX.Element) The text.
 */
export function DText(props: TextProps) {
  return <Text allowFontScaling={false} {...props} />;
}

/**
 * purpose: The paper page: orientation header, a screen's body, and the going-out strip.
 * @param props: ({ day: DayViewData, children: ReactNode }) The day view and the body.
 * @return: (JSX.Element) The page at canvas size.
 */
export function DisplayCanvas({ day, children }: { day: DayViewData; children: ReactNode }) {
  return (
    <View style={styles.canvas}>
      <View style={styles.content}>
        <View accessible accessibilityRole="header" style={styles.header}>
          <DText style={font.header}>{day.header}</DText>
          <DText style={font.date}>{fullDate(day)}</DText>
        </View>
        <View style={styles.body}>{children}</View>
      </View>
      <GoingOutStrip />
    </View>
  );
}

/**
 * purpose: A plain paper page with one centered line, shown while the day loads or when it
 *          cannot be loaded.
 * @param props: ({ text: string }) The line.
 * @return: (JSX.Element) The page at canvas size.
 */
export function DisplayMessage({ text }: { text: string }) {
  return (
    <View style={[styles.canvas, styles.centered]}>
      <DText style={font.clearTitle}>{text}</DText>
    </View>
  );
}

/**
 * purpose: The fixed reminder at the bottom of the page; nothing to press.
 * @return: (JSX.Element) The strip.
 */
function GoingOutStrip() {
  return (
    <View
      accessible
      accessibilityLabel="Going out? Take your wallet, keys, glasses and phone."
      style={styles.strip}
    >
      <SymbolView name="figure.walk" size={40} weight="bold" tintColor={ink.ink} />
      <DText style={font.stripLead}>Going out?</DText>
      <DText style={font.stripItems}>Wallet · Keys · Glasses · Phone</DText>
    </View>
  );
}

/**
 * purpose: A drawing of a physical key (outlined, rounded) inside a prompt, for example
 *          "Press [check Done]". Not pressable.
 * @param props: ({ icon: SFSymbol, label: string }) The key's symbol and word.
 * @return: (JSX.Element) The keycap.
 */
function Keycap({ icon, label }: { icon: SFSymbol; label: string }) {
  return (
    <View style={styles.keycap}>
      <SymbolView name={icon} size={28} weight="bold" tintColor={ink.ink} />
      <DText style={font.keycap}>{label}</DText>
    </View>
  );
}

/**
 * purpose: One prompt line, "<question> Press [key]".
 * @param props: ({ question: string, icon: SFSymbol, keyLabel: string }) The words before
 *        "Press" and the key drawn after it.
 * @return: (JSX.Element) The line.
 */
function PromptLine({
  question,
  icon,
  keyLabel,
}: {
  question: string;
  icon: SFSymbol;
  keyLabel: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${question} Press ${keyLabel}.`}
      style={styles.promptLine}
    >
      <DText style={font.prompt}>{question} Press</DText>
      <Keycap icon={icon} label={keyLabel} />
    </View>
  );
}

/**
 * purpose: The Now screen's body: the Now card and the Next up card side by side. A voice card
 *          replaces the Next up card, or the whole body when nothing is waiting.
 * @param props: ({ card: NowCard, step: number, next: NextItem | null, voice: VoiceCard |
 *        null }) The Now card, the current step index of a multi-step task (0 for others), the
 *        next item, and the voice card (null when there is no voice session or answer).
 * @return: (JSX.Element) The body.
 */
export function NowBody({
  card,
  step,
  next,
  voice,
}: {
  card: NowCard;
  step: number;
  next: NextItem | null;
  voice: VoiceCard | null;
}) {
  if (voice !== null && card.kind === 'clear') {
    return (
      <View style={styles.nowBody}>
        <VoiceCardView card={voice} wide />
      </View>
    );
  }
  return (
    <View style={styles.nowBody}>
      <NowColumn card={card} step={step} />
      <View style={styles.nextColumn}>
        {voice !== null ? (
          <VoiceCardView card={voice} wide={false} />
        ) : (
          next !== null && <NextCard item={next} />
        )}
      </View>
    </View>
  );
}

/**
 * purpose: The voice card: a black tab ("Talk", "Sunny", "Sunny said · 10:42") over a
 *          thick-bordered box holding a symbol with a large title and a detail line
 *          ("Listening", "Ask your question."), or the answer as large text, shrunk only as
 *          far as needed to fit.
 * @param props: ({ card: VoiceCard, wide: boolean }) The card, and whether it has the whole
 *        body (larger answer text) or the Next up column.
 * @return: (JSX.Element) The card.
 */
function VoiceCardView({ card, wide }: { card: VoiceCard; wide: boolean }) {
  const parts =
    card.kind === 'answer' ? [card.tab, card.text] : [card.tab, card.title, card.detail ?? ''];
  const label = parts.filter((part) => part !== '').join('. ');
  return (
    <View accessible accessibilityLabel={label} style={styles.voiceColumn}>
      <View style={styles.tab}>
        <DText style={[font.tab, styles.onInk]} numberOfLines={1}>
          {card.tab}
        </DText>
      </View>
      <View style={[styles.nowBox, styles.voiceBox]}>
        {card.kind === 'answer' ? (
          <DText
            style={[wide ? font.answerWide : font.answer, styles.answerText]}
            numberOfLines={wide ? ANSWER_LINES_WIDE : ANSWER_LINES}
            adjustsFontSizeToFit
            minimumFontScale={ANSWER_MIN_SCALE}
          >
            {card.text}
          </DText>
        ) : (
          <View style={styles.stack}>
            <SymbolView name={card.icon} size={64} weight="bold" tintColor={ink.ink} />
            <DText style={font.voiceTitle}>{card.title}</DText>
            {card.detail !== null && (
              <DText style={font.taskDetail} numberOfLines={4}>
                {card.detail}
              </DText>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * purpose: The tab above the Now card: "Now", "Still to do" for an overdue task or "Later" for
 *          a snoozed one, followed by the task's time (one-step task) or name (multi-step).
 * @param card: (NowCard) The card.
 * @return: (string) The tab text.
 */
function tabText(card: NowCard): string {
  if (card.kind === 'clear') return 'Now';
  const lead = card.task.snoozed ? 'Later' : card.overdue ? 'Still to do' : 'Now';
  const tail = card.steps !== null ? card.task.displayLabel : clockTime(card.task.scheduledTime);
  return `${lead}  ·  ${tail}`;
}

/**
 * purpose: The 600 pt Now column: the black tab and the thick-bordered card.
 * @param props: ({ card: NowCard, step: number }) The card and the current step index.
 * @return: (JSX.Element) The column.
 */
function NowColumn({ card, step }: { card: NowCard; step: number }) {
  return (
    <View style={styles.nowColumn}>
      <View style={styles.tab}>
        <DText style={[font.tab, styles.onInk]}>{tabText(card)}</DText>
      </View>
      <View style={styles.nowBox}>
        {card.kind === 'clear' ? (
          <ClearContent allDone={card.allDone} />
        ) : card.steps !== null ? (
          <StepContent steps={card.steps} step={step} />
        ) : (
          <TaskContent card={card} />
        )}
      </View>
    </View>
  );
}

/**
 * purpose: The Now card when nothing needs doing.
 * @param props: ({ allDone: boolean }) Whether the whole day is finished.
 * @return: (JSX.Element) The content.
 */
function ClearContent({ allDone }: { allDone: boolean }) {
  return (
    <View accessible style={styles.stack}>
      {allDone && <SymbolView name="checkmark" size={64} weight="bold" tintColor={ink.ink} />}
      <DText style={font.clearTitle}>
        {allDone ? 'Everything is done.' : 'Nothing to do right now.'}
      </DText>
    </View>
  );
}

/**
 * purpose: The Now card for a one-step task: icon, title, pill description, and the prompt to
 *          press Done. An overdue task drops the icon to make room for the second prompt,
 *          "Not sure? Press [Talk]".
 * @param props: ({ card }) The task card.
 * @return: (JSX.Element) The content.
 */
function TaskContent({ card }: { card: TaskCard }) {
  const { task } = card;
  return (
    <>
      <View accessible style={styles.stack}>
        {!card.overdue && (
          <SymbolView name={taskIcon(task.type)} size={64} weight="bold" tintColor={ink.ink} />
        )}
        <DText style={font.taskTitle} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>
          {task.displayLabel}
        </DText>
        {task.pillDescription !== null && (
          <DText style={font.taskDetail} numberOfLines={2}>
            {task.pillDescription}
          </DText>
        )}
      </View>
      <View style={styles.prompts}>
        <PromptLine question={doneQuestion(task)} icon="checkmark" keyLabel="Done" />
        {card.overdue && <PromptLine question="Not sure?" icon="mic" keyLabel="Talk" />}
      </View>
    </>
  );
}

/**
 * purpose: The Now card for a multi-step task: progress boxes with "Step n of N", the current
 *          step large, and the prompt to press Done when it is finished.
 * @param props: ({ steps: string[], step: number }) The steps and the current index.
 * @return: (JSX.Element) The content.
 */
function StepContent({ steps, step }: { steps: string[]; step: number }) {
  const current = Math.min(step, steps.length - 1);
  const counter = `Step ${current + 1} of ${steps.length}`;
  return (
    <>
      <View accessible accessibilityLabel={`${counter}. ${steps[current]}`} style={styles.stack}>
        <View style={styles.progress}>
          {steps.length <= MAX_PROGRESS_BOXES &&
            steps.map((text, i) => (
              <View
                key={`${i}-${text}`}
                style={[
                  styles.progressBox,
                  i < current && styles.progressDone,
                  i === current && styles.progressNow,
                ]}
              >
                {i < current && (
                  <SymbolView name="checkmark" size={32} weight="bold" tintColor={ink.paper} />
                )}
              </View>
            ))}
          <DText style={font.prompt}>{counter}</DText>
        </View>
        <DText style={font.stepTitle} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.7}>
          {steps[current]}
        </DText>
      </View>
      <View style={styles.prompts}>
        <PromptLine question="Finished?" icon="checkmark" keyLabel="Done" />
      </View>
    </>
  );
}

/**
 * purpose: The Next up column's card: a circle with the visitor's initial or the item's icon,
 *          the title, and when.
 * @param props: ({ item: NextItem }) The next item.
 * @return: (JSX.Element) The label and card.
 */
function NextCard({ item }: { item: NextItem }) {
  return (
    <>
      <View style={styles.nextLabel}>
        <DText style={font.nextLabel}>Next up</DText>
      </View>
      <View
        accessible
        accessibilityLabel={`Next up: ${item.title}, ${item.when}`}
        style={styles.nextBox}
      >
        <View style={styles.avatar}>
          {item.initial !== null ? (
            <DText style={styles.initial}>{item.initial}</DText>
          ) : (
            <SymbolView name={item.icon} size={36} weight="bold" tintColor={ink.ink} />
          )}
        </View>
        <View style={styles.nextText}>
          <DText style={font.nextTitle} numberOfLines={2}>
            {item.title}
          </DText>
          <DText style={font.nextTime}>{item.when}</DText>
        </View>
      </View>
    </>
  );
}

/**
 * purpose: The Today screen's body: one row per task or event, and a closing line when some
 *          later rows did not fit.
 * @param props: ({ rows: TodayRow[], hidden: number }) The rows and the count left out.
 * @return: (JSX.Element) The list.
 */
export function TodayBody({ rows, hidden }: { rows: TodayRow[]; hidden: number }) {
  return (
    <View>
      {rows.map((row) => (
        <TodayLine key={row.key} row={row} />
      ))}
      {hidden > 0 && (
        <View style={styles.row}>
          <DText style={[font.rowLabel, styles.grey]}>{`And ${hidden} more later`}</DText>
        </View>
      )}
      {rows.length === 0 && (
        <View style={styles.row}>
          <DText style={font.rowLabel}>Nothing planned today.</DText>
        </View>
      )}
    </View>
  );
}

/**
 * purpose: One Today row: time, label, and a grey check (done) or a black "Now" tag (the Now
 *          task, which is also boxed).
 * @param props: ({ row: TodayRow }) The row.
 * @return: (JSX.Element) The row.
 */
function TodayLine({ row }: { row: TodayRow }) {
  const done = row.mark === 'done';
  const now = row.mark === 'now';
  return (
    <View
      accessible
      accessibilityLabel={`${row.time}, ${row.label}`}
      accessibilityValue={done || now ? { text: done ? 'Done' : 'Now' } : undefined}
      style={[styles.row, now && styles.rowNow]}
    >
      <DText style={[font.rowTime, styles.rowTime, done && styles.grey]}>{row.time}</DText>
      <DText
        style={[now ? font.rowLabelNow : font.rowLabel, styles.rowLabel, done && styles.grey]}
        numberOfLines={1}
      >
        {row.label}
      </DText>
      {done && <SymbolView name="checkmark" size={30} weight="bold" tintColor={ink.grey} />}
      {now && (
        <View style={styles.nowTag}>
          <DText style={[font.tab, styles.onInk]}>Now</DText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    width: CANVAS.width,
    height: CANVAS.height,
    paddingTop: 28,
    backgroundColor: ink.paper,
    overflow: 'hidden',
  },
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, paddingHorizontal: 48, paddingBottom: 28, gap: 28 },
  header: { gap: 6, paddingBottom: 24, borderBottomWidth: 6, borderColor: ink.ink },
  body: { flex: 1 },
  strip: {
    height: 100,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 48,
    borderTopWidth: 3,
    borderColor: ink.ink,
  },
  keycap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingLeft: 14,
    paddingRight: 18,
    borderWidth: 3,
    borderRadius: 12,
    borderColor: ink.ink,
  },
  promptLine: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  prompts: { gap: 16, paddingTop: 24, borderTopWidth: 3, borderColor: ink.ink },
  nowBody: { flex: 1, flexDirection: 'row', gap: 32 },
  nowColumn: { width: 600 },
  tab: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 20,
    backgroundColor: ink.ink,
  },
  onInk: { color: ink.paper },
  nowBox: {
    flex: 1,
    justifyContent: 'space-between',
    gap: 24,
    paddingTop: 36,
    paddingHorizontal: 36,
    paddingBottom: 32,
    borderWidth: 6,
    borderColor: ink.ink,
  },
  stack: { gap: 12 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 12 },
  progressBox: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: ink.ink,
  },
  progressDone: { backgroundColor: ink.ink },
  progressNow: { borderWidth: 6 },
  nextColumn: { flex: 1 },
  voiceColumn: { flex: 1 },
  voiceBox: { justifyContent: 'flex-start' },
  // Fills the box, so the text has a bounded height to shrink into.
  answerText: { flex: 1 },
  nextLabel: { paddingVertical: 8 },
  nextBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingVertical: 32,
    paddingHorizontal: 28,
    borderWidth: 3,
    borderColor: ink.ink,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: ink.ink,
  },
  initial: { ...font.header, fontSize: 38, lineHeight: 46 },
  nextText: { flex: 1, gap: 2 },
  row: {
    height: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    paddingHorizontal: 20,
  },
  rowNow: { borderWidth: 5, borderColor: ink.ink },
  rowTime: { width: 150 },
  rowLabel: { flex: 1 },
  grey: { color: ink.grey },
  nowTag: { paddingVertical: 4, paddingHorizontal: 16, backgroundColor: ink.ink },
});
