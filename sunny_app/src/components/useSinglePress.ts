import { useEffect, useRef, useState } from 'react';

export interface SinglePress {
  pressing: boolean;
  press: () => Promise<void>;
}

export function useSinglePress(action: () => void | Promise<void>, blocked: boolean): SinglePress {
  const [pressing, setPressing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const press = async (): Promise<void> => {
    if (blocked || pressing) return;
    setPressing(true);
    try {
      await action();
    } finally {
      if (mounted.current) setPressing(false);
    }
  };

  return { pressing, press };
}
