// sunny_app/src/theme/useKeyboardVisible.ts
//
// Purpose: Hook that reports whether the software keyboard is showing, shared by the voice
// conversation screen (which hides its control bar) and the caregiver app (which hides the
// floating tab bar). It follows the keyboardWillShow and keyboardWillHide events so the UI
// changes together with the keyboard animation.
//
// Last modified: 2026-10-31

import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/**
 * purpose: Track whether the software keyboard is showing.
 * @return: (boolean) true between the keyboard starting to show and starting to hide
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
