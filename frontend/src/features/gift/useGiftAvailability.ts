import { useContext } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { billingService } from '@/services/billingService';
import { isNativeApp } from '@/lib/platform';

/**
 * Whether this deployment can sell a gift right now.
 *
 * Reads the public plan catalog (`GET /billing/plans`), the same read the
 * pricing page makes. Its `giftSubscriptions.plans[].available` is computed by
 * the API from the same check the checkout route runs
 * (`isGiftConfigured`, i.e. the `STRIPE_PRICE_ID_GIFT_*` variables) together
 * with the payments gate, so a tier with no gift price id reads `false` here
 * and `POST /billing/gift/checkout` answers 400 `GIFT_NOT_CONFIGURED` for it.
 *
 * Fails closed: while the catalog is loading, when it cannot be read, or when
 * it carries no gift offer (an older API), nothing is offered. `loading` lets
 * the /gift page wait instead of flashing "not available". `payments-off` is
 * the payments gate (commercial hold) rather than a missing price id; the
 * /gift page keeps showing its own commercial-hold notice for that case.
 */
export type GiftAvailability = 'loading' | 'available' | 'payments-off' | 'unavailable';

/**
 * The footer sits in the shared public shell, which is also rendered on its own
 * (isolated renders have no `QueryClientProvider`). With no provider this hook
 * never fetches and reports `unavailable`, so a Gift link cannot appear from a
 * tree that has no catalog to ask. The app always mounts a provider.
 */
const NO_PROVIDER_CLIENT = new QueryClient();

export function useGiftAvailability(): GiftAvailability {
  // The apps never sell or advertise gifts (Guideline 3.1.1), so they do not
  // even read the catalog for this.
  const native = isNativeApp();
  const provided = useContext(QueryClientContext);
  const plansQuery = useQuery(
    {
      queryKey: ['plans'],
      queryFn: billingService.listPlans,
      enabled: !native && provided !== undefined,
    },
    provided ?? NO_PROVIDER_CLIENT
  );
  if (native || provided === undefined) return 'unavailable';
  if (plansQuery.isPending) return 'loading';
  const data = plansQuery.data;
  if (!data) return 'unavailable';
  if (data.paymentsAvailable !== true) return 'payments-off';
  return data.giftSubscriptions?.plans.some((p) => p.available) ? 'available' : 'unavailable';
}
