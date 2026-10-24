import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { appStorePurchasesAvailable } from '@/services/appStoreAvailability';

/**
 * In the iPhone app with App Store purchases on (ADR 0041), keeps the server
 * current with what StoreKit knows while someone is signed in to a household:
 * the subscriptions this Apple ID holds at launch, and every transaction
 * update after. Refreshes the plan when one lands. Does nothing on the
 * website, on Android, or in a build with purchases off; the purchase flow
 * and the StoreKit plugin are loaded only past that check.
 */
export function useAppStoreTransactionSync(active: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!active || !appStorePurchasesAvailable()) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('@/services/appStorePurchases')
      .then(({ startTransactionSync }) =>
        startTransactionSync(() => {
          void queryClient.invalidateQueries({ queryKey: ['subscription'] });
        })
      )
      .then((s) => {
        if (cancelled) s();
        else stop = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [active, queryClient]);
}
