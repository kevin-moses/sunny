// sunny_app/src/theme/useReduceMotion.ts
//
// Purpose: Hook that reports whether the user enabled iOS Reduce Motion, updating live when
// the setting changes. Voice UI animations (shimmer, bar sequencing) are skipped when true.
//
// Last modified: 2026-10-28

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * purpose: Track the system Reduce Motion setting.
 * @return: (boolean) true when the user prefers reduced motion
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
