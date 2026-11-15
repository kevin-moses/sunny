import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';

export type CaregiverTab = 'home' | 'chat' | 'about';

const TABS = [
  { id: 'home', label: 'Home', icon: 'house', activeIcon: 'house.fill' },
  { id: 'chat', label: 'Chat', icon: 'bubble.left', activeIcon: 'bubble.left.fill' },
  {
    id: 'about',
    label: 'About',
    icon: 'person.text.rectangle',
    activeIcon: 'person.text.rectangle.fill',
  },
] as const;

const PILL_PADDING = 4;
const TAB_PADDING_VERTICAL = 8;
const ICON_SIZE = 22;
const TAB_GAP = 4;
const LABEL_LINE_HEIGHT = 16;
const TAB_BAR_BOTTOM_GAP = 8;
const CONTENT_GAP = 16;

export const TAB_BAR_HEIGHT =
  PILL_PADDING * 2 + TAB_PADDING_VERTICAL * 2 + ICON_SIZE + TAB_GAP + LABEL_LINE_HEIGHT;

export function tabBarClearance(bottomInset: number): number {
  return TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_GAP + bottomInset + CONTENT_GAP;
}

interface CaregiverTabBarProps {
  active: CaregiverTab;
  onChange: (tab: CaregiverTab) => void;
  aboutLabel: string;
}

export function CaregiverTabBar({ active, onChange, aboutLabel }: CaregiverTabBarProps) {
  const { accentColor } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrapper, { bottom: insets.bottom + TAB_BAR_BOTTOM_GAP }]}
    >
      <View accessibilityRole="tablist" style={styles.pill}>
        {TABS.map((tab) => {
          const selected = tab.id === active;
          const color = selected ? colors.text : colors.secondaryText;
          const label = tab.id === 'about' ? aboutLabel : tab.label;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              onPress={() => onChange(tab.id)}
              style={[styles.tab, selected && { backgroundColor: `${accentColor}40` }]}
            >
              <SymbolView
                name={selected ? tab.activeIcon : tab.icon}
                size={ICON_SIZE}
                tintColor={color}
              />
              <Text
                numberOfLines={1}
                style={[type.caption, { color, lineHeight: LABEL_LINE_HEIGHT }]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    gap: 4,
    padding: PILL_PADDING,
    borderRadius: 999,
    backgroundColor: colors.overlayStrong,
    shadowColor: colors.ink,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 16,
  },
  tab: {
    width: 104,
    paddingVertical: TAB_PADDING_VERTICAL,
    gap: TAB_GAP,
    borderRadius: 999,
    alignItems: 'center',
  },
});
