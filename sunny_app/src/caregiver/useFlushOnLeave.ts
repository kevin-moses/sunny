import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

export function useFlushOnLeave(flush: () => void): void {
  const flushRef = useRef(flush);

  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') flushRef.current();
    });
    return () => {
      subscription.remove();
      flushRef.current();
    };
  }, []);
}
