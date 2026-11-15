import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';

import { clockTime, displayTime, SPOKEN } from '../day/format';
import type { DayViewData } from '../day/types';
import { doneQuestion, fullDate, taskIcon } from './model';
import type { NextItem, NowCard, TaskCard, TodayRow } from './model';
import { CANVAS, TAB_SEPARATOR, font, ink } from './theme';
import type { VoiceCard } from './voiceModel';

const MAX_PROGRESS_BOXES = 5;

const ANSWER_MIN_SCALE = 0.6;

const ANSWER_LINES = 11;
const ANSWER_LINES_WIDE = 9;

export function DText(props: TextProps) {
  return <Text allowFontScaling={false} {...props} />;
}

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

export function DisplayMessage({ text }: { text: string }) {
  return (
    <View style={[styles.canvas, styles.centered]}>
      <DText style={font.clearTitle}>{text}</DText>
    </View>
  );
}

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

function Keycap({ icon, label }: { icon: SFSymbol; label: string }) {
  return (
    <View style={styles.keycap}>
      <SymbolView name={icon} size={28} weight="bold" tintColor={ink.ink} />
      <DText style={font.keycap}>{label}</DText>
    </View>
  );
}

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

function VoiceCardView({ card, wide }: { card: VoiceCard; wide: boolean }) {
  const parts =
    card.kind === 'answer' ? [card.tab, card.text] : [card.tab, card.title, card.detail];
  const label = parts.filter(Boolean).join('. ');
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

function tabLead(card: TaskCard): string {
  if (card.task.snoozed) return 'Later';
  if (card.overdue) return 'Still to do';
  return 'Now';
}

function tabTime(card: TaskCard): string {
  const time = card.task.scheduledTime;
  return card.task.snoozed ? displayTime(time) : clockTime(time);
}

export function tabText(card: NowCard): string {
  if (card.kind === 'clear') return 'Now';
  const tail = card.steps !== null ? card.task.displayLabel : tabTime(card);
  return `${tabLead(card)}${TAB_SEPARATOR}${tail}`;
}

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

function todayRowValue(mark: TodayRow['mark']): { text: string } | undefined {
  switch (mark) {
    case 'done':
      return { text: SPOKEN.done };
    case 'now':
      return { text: SPOKEN.now };
    case 'missed':
      return { text: SPOKEN.missed };
    case 'none':
      return undefined;
  }
}

function TodayLine({ row }: { row: TodayRow }) {
  const done = row.mark === 'done';
  const now = row.mark === 'now';
  const grey = done || row.mark === 'missed';
  return (
    <View
      accessible
      accessibilityLabel={`${row.time}, ${row.label}`}
      accessibilityValue={todayRowValue(row.mark)}
      style={[styles.row, now && styles.rowNow]}
    >
      <DText style={[font.rowTime, styles.rowTime, grey && styles.grey]}>{row.time}</DText>
      <DText
        style={[now ? font.rowLabelNow : font.rowLabel, styles.rowLabel, grey && styles.grey]}
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
