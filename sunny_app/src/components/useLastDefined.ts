import { useState } from 'react';

export function useLastDefined<T>(value: T | undefined): T | undefined {
  const [last, setLast] = useState(value);
  if (value !== undefined && value !== last) setLast(() => value);
  return value === undefined ? last : value;
}
