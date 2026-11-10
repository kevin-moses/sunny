// sunny_app/src/caregiver/CaregiverTabBar.tsx
//
// Purpose: The caregiver app's floating tab bar: a translucent pill centered above the home
// indicator with three tabs (Home, Chat and About, whose label names the senior when it fits,
// for example "About Mom"). The active tab has an accent-tinted background and a filled icon.
// The bar's size is derived from its own style constants (TAB_BAR_HEIGHT), and tabBarClearance
// says how much room screens leave for it; CaregiverApp passes that to the screens (see
// tabBarInset). Screens scroll under the bar.
//
// Last modified: 2026-11-09

import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../theme/colors';
import { useTheme } from '../theme/ThemeProvider';
import { type } from '../theme/typography';

/** The caregiver app's tabs. */
export type CaregiverTab = 'home' | 'chat' | 'about';

/** One tab's label (the About tab's comes from a prop) and its outline and filled icons. */
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

/** Padding (points) between the pill edge and the tabs. */
const PILL_PADDING = 4;
/** Vertical padding (points) inside a tab. */
const TAB_PADDING_VERTICAL = 8;
/** Size (points) of a tab's icon. */
const ICON_SIZE = 22;
/** Gap (points) between a tab's icon and label. */
const TAB_GAP = 4;
/** Line height (points) of a tab's label. */
const LABEL_LINE_HEIGHT = 16;
/** Gap (points) between the tab bar and the bottom safe-area edge. */
const TAB_BAR_BOTTOM_GAP = 8;
/** Space (points) left between the bar and the content above it. */
const CONTENT_GAP = 16;

/** Height (points) of the floating pill, from the constants its styles use. */
export const TAB_BAR_HEIGHT =
  PILL_PADDING * 2 + TAB_PADDING_VERTICAL * 2 + ICON_SIZE + TAB_GAP + LABEL_LINE_HEIGHT;

/**
 * purpose: How much room screens leave at the bottom so content clears the floating tab bar.
 * @param bottomInset: (number) The bottom safe-area inset.
 * @return: (number) Points of clearance, including a small gap above the bar.
 */
export function tabBarClearance(bottomInset: number): number {
  return TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_GAP + bottomInset + CONTENT_GAP;
}

/** Props for CaregiverTabBar. */
interface CaregiverTabBarProps {
  active: CaregiverTab;
  onChange: (tab: CaregiverTab) => void;
  /** The About tab's label, for example "About Mom" (see aboutTabLabel). */
  aboutLabel: string;
}

/**
 * purpose: Render the floating tab bar.
 * @param props: (CaregiverTabBarProps) The active tab, the change handler and the About tab's
 *        label.
 * @return: (JSX.Element) The bar, absolutely positioned at the bottom of its parent.
 */
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
