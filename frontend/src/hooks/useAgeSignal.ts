import { useEffect, useState } from 'react';
import type { AgeSignal } from '@/lib/ageSignal';
import { loadAgeSignal, onAgeSignal, settledAgeSignal } from '@/services/nativeAgeRange';

/** This launch's app-store age signal; null while the first request runs. */
export function useAgeSignal(): AgeSignal | null {
  const [signal, setSignal] = useState<AgeSignal | null>(() => settledAgeSignal());
  useEffect(() => {
    if (signal) return undefined;
    const off = onAgeSignal(setSignal);
    void loadAgeSignal().then(setSignal);
    return off;
  }, [signal]);
  return signal;
}
