import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { PaperText } from '../phone/PaperText';
import { layout, paper, roles, shadows } from '../phone/theme';
import { useVoice } from './voiceContext';

export const TALK_LABEL = 'Talk to Sunny';

export const CONNECTING_LABEL = 'Connecting';

export function TalkButton(): ReactElement {
  const { connect, connectionState } = useVoice();
  const [pressing, setPressing] = useState(false);
  const mounted = useRef(true);
  const busy = connectionState === 'connecting' || pressing;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handlePress = async (): Promise<void> => {
    if (busy) return;
    setPressing(true);
    try {
      await connect();
    } finally {
      if (mounted.current) setPressing(false);
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={TALK_LABEL}
      accessibilityHint="Double-tap to connect and start speaking"
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={() => void handlePress()}
      style={({ pressed }) => [
        styles.key,
        { boxShadow: pressed || busy ? shadows.talkPressed : shadows.talk },
      ]}
    >
      <View style={styles.icon}>
        {busy ? (
          <ActivityIndicator color={paper.ink} />
        ) : (
          <SymbolView name="mic.fill" size={30} weight="bold" tintColor={paper.ink} />
        )}
      </View>
      <PaperText
        textRole={roles.talk}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        style={styles.label}
      >
        {busy ? CONNECTING_LABEL : TALK_LABEL}
      </PaperText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  key: {
    height: layout.talk,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: layout.side,
    borderRadius: layout.talk / 2,
    backgroundColor: paper.talk,
  },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  label: { flexShrink: 1 },
});
