import { Text, type TextProps } from 'react-native';

import type { TextRole } from './theme';

export function PaperText({ textRole, style, ...rest }: TextProps & { textRole: TextRole }) {
  return (
    <Text {...rest} maxFontSizeMultiplier={textRole.maxScale} style={[textRole.style, style]} />
  );
}
