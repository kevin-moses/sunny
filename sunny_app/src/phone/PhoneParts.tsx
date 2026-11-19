import { SymbolView } from 'expo-symbols';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { SPOKEN } from '../day/format';
import type { DayTask } from '../day/types';
import type { UndoLineData } from '../day/useDoneAction';
import {
  comingUpAt,
  NOTHING_DUE,
  stepTag,
  taskHeadline,
  type DayRow,
  type ScreenMode,
} from './model';
import { PaperText } from './PaperText';
import { DoneKey, NextPanel, NotedPanel, UndoKey } from './PhoneKeys';
import { cappedScale, layout, paper, roles } from './theme';

function TaskTags({ task, early }: { task: DayTask; early: boolean }) {
  const step = stepTag(task);
  return (
    <>
      {early ? (
        <PaperText textRole={roles.tag} numberOfLines={1} adjustsFontSizeToFit style={styles.lead}>
          {comingUpAt(task)}
        </PaperText>
      ) : (
        <View style={styles.nowTag}>
          <PaperText textRole={roles.tag}>{SPOKEN.now}</PaperText>
        </View>
      )}
      {step !== null && (
        <PaperText textRole={roles.step} numberOfLines={1} style={styles.step}>
          {step}
        </PaperText>
      )}
    </>
  );
}

export function TagRow({ mode }: { mode: ScreenMode | null }) {
  return (
    <View style={styles.tagRow}>
      {mode?.kind === 'task' && <TaskTags task={mode.task} early={mode.early} />}
    </View>
  );
}

function Sentence({ text }: { text: string }) {
  return (
    <PaperText
      textRole={roles.headline}
      adjustsFontSizeToFit
      minimumFontScale={0.4}
      lineBreakStrategyIOS="standard"
      style={styles.shrink}
    >
      {text}
    </PaperText>
  );
}

function Detail({ text }: { text: string }) {
  return (
    <PaperText
      textRole={roles.detail}
      numberOfLines={2}
      adjustsFontSizeToFit
      minimumFontScale={0.7}
    >
      {text}
    </PaperText>
  );
}

function UndoRow({ undo, onUndo }: { undo: UndoLineData; onUndo: () => void }) {
  return (
    <View style={styles.undoRow}>
      <UndoKey undo={undo} onPress={onUndo} />
      <PaperText
        textRole={roles.undoNote}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        style={styles.undoNote}
      >
        {undo.text}
      </PaperText>
    </View>
  );
}

function Noted({ undo, onUndo }: { undo: UndoLineData; onUndo: () => void }) {
  return (
    <View style={[styles.noted, styles.shrink]}>
      <PaperText
        textRole={roles.undoLine}
        adjustsFontSizeToFit
        minimumFontScale={0.5}
        lineBreakStrategyIOS="standard"
        style={styles.shrink}
      >
        {undo.text}
      </PaperText>
      <UndoKey undo={undo} onPress={onUndo} />
    </View>
  );
}

function HeadlineContent({ mode, onUndo }: { mode: ScreenMode; onUndo: () => void }) {
  switch (mode.kind) {
    case 'task': {
      const headline = taskHeadline(mode.task);
      const detail = mode.message ?? headline.detail;
      return (
        <>
          <Sentence text={headline.sentence} />
          {detail !== null && <Detail text={detail} />}
          {mode.undo !== null && <UndoRow undo={mode.undo} onUndo={onUndo} />}
        </>
      );
    }
    case 'noted':
      return (
        <>
          <Noted undo={mode.undo} onUndo={onUndo} />
          {mode.message !== null && <Detail text={mode.message} />}
        </>
      );
    case 'notice':
      return <Sentence text={mode.message} />;
    case 'clear':
      return <Sentence text={NOTHING_DUE} />;
  }
}

export function HeadlineSlot({ mode, onUndo }: { mode: ScreenMode; onUndo: () => void }) {
  return (
    <View style={styles.headline}>
      <HeadlineContent mode={mode} onUndo={onUndo} />
    </View>
  );
}

export function MessageSlot({ text }: { text: string }) {
  return (
    <View style={styles.headline}>
      <Detail text={text} />
    </View>
  );
}

function DoneContent({ mode, onDone }: { mode: ScreenMode; onDone: () => void }) {
  switch (mode.kind) {
    case 'task':
      return <DoneKey task={mode.task} early={mode.early} onPress={onDone} />;
    case 'noted':
      return <NotedPanel text={mode.noted} />;
    case 'clear':
      return mode.next === null ? null : <NextPanel text={mode.next} />;
    case 'notice':
      return null;
  }
}

export function DoneSlot({ mode, onDone }: { mode: ScreenMode; onDone: () => void }) {
  return (
    <View style={styles.doneSlot}>
      <DoneContent mode={mode} onDone={onDone} />
    </View>
  );
}

function RowMark({ row, color }: { row: DayRow; color: string }) {
  switch (row.mark) {
    case 'done':
      return <SymbolView name="checkmark" size={26} weight="bold" tintColor={color} />;
    case 'event':
      return <SymbolView name="calendar" size={22} weight="bold" tintColor={color} />;
    case 'none':
      return null;
  }
}

function DayRowView({ row, scale }: { row: DayRow; scale: number }) {
  const strong = row.tone === 'now' || row.tone === 'early';
  const color = row.tone === 'grey' ? paper.grey : paper.ink;
  const colorStyle = { color };
  return (
    <View
      accessible
      accessibilityLabel={`${row.time}, ${row.label}`}
      accessibilityValue={{ text: row.spoken }}
      style={[styles.row, { minHeight: layout.row * scale }, row.tone === 'now' && styles.nowRow]}
    >
      <View style={styles.mark}>
        <RowMark row={row} color={color} />
      </View>
      <PaperText
        textRole={strong ? roles.rowStrong : roles.rowTime}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[{ width: layout.timeColumn * scale }, colorStyle]}
      >
        {row.time}
      </PaperText>
      <PaperText
        textRole={strong ? roles.rowStrong : roles.rowLabel}
        style={[styles.label, colorStyle]}
      >
        {row.label}
      </PaperText>
    </View>
  );
}

export function DayList({ rows }: { rows: readonly DayRow[] }) {
  const { fontScale } = useWindowDimensions();
  const scale = cappedScale(fontScale, roles.rowTime);
  return (
    <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
      {rows.map((row) => (
        <DayRowView key={row.key} row={row} scale={scale} />
      ))}
    </ScrollView>
  );
}

export function OfflineNote() {
  return (
    <View accessible accessibilityLabel="Not connected" style={styles.offline}>
      <SymbolView name="wifi.slash" size={22} weight="bold" tintColor={paper.grey} />
      <PaperText textRole={roles.offline} style={styles.offlineText}>
        Not connected
      </PaperText>
    </View>
  );
}

const styles = StyleSheet.create({
  tagRow: {
    height: layout.tagRow,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  nowTag: {
    backgroundColor: paper.now,
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  lead: { flexShrink: 1 },
  step: { marginLeft: 'auto' },
  headline: { height: layout.headline, gap: layout.headlineGap },
  shrink: { flexShrink: 1 },
  noted: { gap: layout.undoGap, alignItems: 'flex-start' },
  undoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  undoNote: { flex: 1 },
  doneSlot: { height: layout.doneSlot },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 10,
    paddingRight: 8,
  },
  nowRow: { backgroundColor: paper.now, borderRadius: layout.rowRadius },
  mark: { width: layout.mark, height: layout.mark, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1 },
  offline: {
    position: 'absolute',
    top: layout.offlineTop,
    right: layout.side,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  offlineText: { color: paper.grey },
});
