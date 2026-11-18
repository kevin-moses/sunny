import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function useTimeout(callback: () => void, ms: number | null, key?: unknown): void {
  const latest = useLatest(callback);
  useEffect(() => {
    if (ms === null) return undefined;
    const timer = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(timer);
  }, [ms, key, latest]);
}
