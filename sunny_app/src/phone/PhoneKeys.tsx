import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import type { DayTask } from '../day/types';
import type { UndoLineData } from '../day/useDoneAction';
import { doneKeyLabel, notedAt } from './model';
import { PaperText } from './PaperText';
import { layout, paper, roles, shadows, type TextRole } from './theme';

interface FaceProps {
  icon: SFSymbol;
  iconSize: number;
  gap: number;
  label: string;
  textRole: TextRole;
  color: string;
}

function KeyFace({ icon, iconSize, gap, label, textRole, color }: FaceProps) {
  return (
    <View style={[styles.face, { gap }]}>
      <SymbolView name={icon} size={iconSize} weight="bold" tintColor={color} />
      <PaperText
        textRole={textRole}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        style={[styles.faceLabel, { color }]}
      >
        {label}
      </PaperText>
    </View>
  );
}

export function DoneKey({
  task,
  early,
  onPress,
}: {
  task: DayTask;
  early: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={doneKeyLabel(task, early)}
      onPress={onPress}
      style={({ pressed }) =>
        early
          ? [styles.key, styles.earlyKey, pressed && styles.paperPressed]
          : [styles.key, styles.dueKey, { boxShadow: pressed ? shadows.donePressed : shadows.done }]
      }
    >
      {early ? (
        <KeyFace
          icon="checkmark"
          iconSize={40}
          gap={14}
          label="Done early"
          textRole={roles.earlyKey}
          color={paper.ink}
        />
      ) : (
        <KeyFace
          icon="checkmark"
          iconSize={44}
          gap={14}
          label="Done"
          textRole={roles.doneKey}
          color={paper.paper}
        />
      )}
    </Pressable>
  );
}

export function NotedPanel({ pressedAt }: { pressedAt: number }) {
  const text = notedAt(pressedAt);
  return (
    <View accessible accessibilityLabel={text} style={[styles.key, styles.panel]}>
      <KeyFace
        icon="checkmark"
        iconSize={34}
        gap={12}
        label={text}
        textRole={roles.keyStatus}
        color={paper.ink}
      />
    </View>
  );
}

export function NextPanel({ text }: { text: string }) {
  return (
    <View accessible accessibilityLabel={text} style={[styles.key, styles.panel]}>
      <PaperText
        textRole={roles.next}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        lineBreakStrategyIOS="standard"
        style={styles.nextText}
      >
        {text}
      </PaperText>
    </View>
  );
}

export function UndoKey({ undo, onPress }: { undo: UndoLineData; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Undo ${undo.label} done`}
      onPress={onPress}
      style={({ pressed }) => [styles.undoKey, pressed && styles.paperPressed]}
    >
      <KeyFace
        icon="arrow.uturn.backward"
        iconSize={30}
        gap={8}
        label="Undo"
        textRole={roles.keyStatus}
        color={paper.ink}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  face: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  faceLabel: { flexShrink: 1 },
  key: {
    height: layout.key,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: layout.side,
    borderRadius: layout.keyRadius,
  },
  dueKey: { backgroundColor: paper.ink },
  earlyKey: {
    backgroundColor: paper.paper,
    borderWidth: layout.outline,
    borderColor: paper.ink,
    boxShadow: shadows.early,
  },
  paperPressed: { backgroundColor: paper.panel },
  panel: { backgroundColor: paper.panel },
  nextText: { textAlign: 'center' },
  undoKey: {
    width: layout.undoWidth,
    height: layout.undoHeight,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: layout.undoRadius,
    borderWidth: layout.outline,
    borderColor: paper.ink,
    backgroundColor: paper.paper,
    boxShadow: shadows.undo,
  },
});
