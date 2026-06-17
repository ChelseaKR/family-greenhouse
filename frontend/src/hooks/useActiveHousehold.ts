import { useMemo } from 'react';
import type { QueryKey, UseQueryOptions } from '@tanstack/react-query';
import { useActiveHouseholdId } from './useActiveHouseholdId';

/**
 * Ergonomic accessor for "the active household id, guaranteed present".
 *
 * Household-scoped requests carry the active household id (see
 * {@link useActiveHouseholdId} for the resolution + query-key convention).
 * Every such query previously threaded a `householdId!` non-null assertion
 * into its `queryFn`, paired with a physically-separate `enabled: !!householdId`
 * guard. The assertion is only sound *because* of that guard — copy a query
 * without it and you get a latent "called the API with a null household" bug
 * that still type-checks.
 *
 * `householdQuery` collapses the assertion and the guard into one place: it
 * hands the `queryFn` a non-null `householdId` and bakes in `enabled` so a
 * call site can't forget it. The `!` lives here, behind the gate, exactly
 * once.
 *
 * Usage:
 *   const { householdQuery } = useActiveHousehold();
 *   useQuery(
 *     householdQuery(
 *       (hh) => ['household', hh, 'climate'],
 *       (hh) => climateService.getClimate(hh),
 *       { staleTime: 30 * 60 * 1000 },
 *     ),
 *   );
 *
 * When no household is active, `householdId` is `null`, the returned query is
 * `enabled: false`, and the `queryFn` is never invoked — so the `hh!` below is
 * always reached with a real id.
 */

/** react-query options a caller may set without owning the household gate. */
type HouseholdQueryExtra<TData> = Omit<
  UseQueryOptions<TData, Error, TData, QueryKey>,
  'queryKey' | 'queryFn' | 'enabled'
> & {
  /**
   * Extra precondition AND-ed with the household gate. Use for call sites that
   * also depend on a second value (e.g. a route param) before fetching.
   */
  enabled?: boolean;
};

export interface UseActiveHouseholdResult {
  /** The active household id, or `null` when none is loaded yet. */
  householdId: string | null;
  /**
   * Build react-query options for a household-scoped query. `key` and `run`
   * both receive the guaranteed-present household id; the returned options
   * are `enabled` only when a household is active (AND any extra `enabled`).
   */
  householdQuery: <TData>(
    key: (householdId: string) => QueryKey,
    run: (householdId: string) => Promise<TData>,
    extra?: HouseholdQueryExtra<TData>
  ) => UseQueryOptions<TData, Error, TData, QueryKey>;
}

export function useActiveHousehold(): UseActiveHouseholdResult {
  const householdId = useActiveHouseholdId();

  const householdQuery = useMemo<UseActiveHouseholdResult['householdQuery']>(
    () => (key, run, extra) => {
      const { enabled: extraEnabled, ...rest } = extra ?? {};
      return {
        // Key is built from the (possibly null) id so the cache still keys on
        // household; when null the query is disabled and never runs.
        queryKey: key(householdId ?? ''),
        // The `!` is sound: `enabled` is false whenever householdId is null,
        // so react-query never invokes queryFn without a real id.
        queryFn: () => run(householdId!),
        enabled: householdId != null && extraEnabled !== false,
        ...rest,
      };
    },
    [householdId]
  );

  return { householdId, householdQuery };
}
