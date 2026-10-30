// sunny_app/src/caregiver/CaregiverTabBar.tsx
//
// Purpose: The caregiver app's floating tab bar: a translucent pill centered above the home
// indicator with two tabs (Home and Chat). The active tab has an accent-tinted background and
// a filled icon. Screens scroll under the bar and leave room for it (see tabBarClearance).
//
// Last modified: 2026-10-30

import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { TAB_BAR_BOTTOM_GAP, type } from './typography';

/** The caregiver app's tabs. */
export type CaregiverTab = 'home' | 'chat';

/** One tab's label and its outline and filled icons. */
const TABS = [
  { id: 'home', label: 'Home', icon: 'house', activeIcon: 'house.fill' },
  { id: 'chat', label: 'Chat', icon: 'bubble.left', activeIcon: 'bubble.left.fill' },
] as const;

/** Props for CaregiverTabBar. */
interface CaregiverTabBarProps {
  active: CaregiverTab;
  onChange: (tab: CaregiverTab) => void;
}

/**
 * purpose: Render the floating tab bar.
 * @param props: (CaregiverTabBarProps) The active tab and the change handler.
 * @return: (JSX.Element) The bar, absolutely positioned at the bottom of its parent.
 */
export function CaregiverTabBar({ active, onChange }: CaregiverTabBarProps) {
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
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected }}
              onPress={() => onChange(tab.id)}
              style={[styles.tab, selected && { backgroundColor: `${accentColor}40` }]}
            >
              <SymbolView name={selected ? tab.activeIcon : tab.icon} size={22} tintColor={color} />
              <Text style={[type.caption, { color }]}>{tab.label}</Text>
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
    padding: 4,
    borderRadius: 999,
    backgroundColor: colors.overlayStrong,
    shadowColor: colors.ink,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 16,
  },
  tab: {
    width: 104,
    paddingVertical: 8,
    gap: 4,
    borderRadius: 999,
    alignItems: 'center',
  },
});
