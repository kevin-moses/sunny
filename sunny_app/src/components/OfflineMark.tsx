import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { colors } from '../theme/colors';

export function OfflineMark() {
  return (
    <View accessible accessibilityLabel="Not connected" style={styles.offline}>
      <SymbolView name="wifi.slash" size={14} tintColor={colors.secondaryText} />
      <Text style={{ fontSize: 13, color: colors.secondaryText }}>Not connected</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  offline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
