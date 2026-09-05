import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PlantSpace } from '@/services/plantService';
import { spaceService } from '@/services/spaceService';
import { spaceMap } from '@/utils/spaces';
import { useActiveHouseholdId } from './useActiveHouseholdId';

/**
 * The household's rooms, as a three-state read (ADR 0010).
 *
 * Seven components used to read spaces as
 *
 * ```ts
 * const { data: spaces = [] } = useQuery({ queryKey: ['spaces', householdId], … });
 * ```
 *
 * and none of them bound an outcome field. That default is the coalescing
 * defect in its hardest-to-see form: the collapse happens once, at the
 * declaration, and is invisible at every one of the dozens of use sites
 * downstream. A failed `GET /spaces` therefore reached `spaceOverview` as an
 * empty map, and
 *
 * ```ts
 * const groupId = plant.spaceId && spaceById.has(plant.spaceId) ? plant.spaceId : 'unplaced';
 * ```
 *
 * put EVERY plant in `'unplaced'`. A household that had spent months
 * organising its plants into rooms was told, with no error and no hint, that
 * it had organised nothing.
 *
 * So the read is a discriminated result and the failure state is impossible to
 * drop by forgetting to destructure it:
 *
 * - `loading` — not back yet. Says nothing.
 * - `ready` — `spaces` is the household's rooms, and an empty array here means
 *   the household genuinely has none.
 * - `unavailable` — the read SETTLED without data. `spaces` is empty, and
 *   callers must not read that emptiness as an answer.
 *
 * `byId` is the memoised lookup map every caller was building for itself.
 */
export type SpacesStatus = 'loading' | 'ready' | 'unavailable';

export interface SpacesRead {
  status: SpacesStatus;
  /** The household's rooms. Empty unless `status === 'ready'`. */
  spaces: PlantSpace[];
  /** `spaces` keyed by id. Empty unless `status === 'ready'`. */
  byId: Map<string, PlantSpace>;
  /**
   * The read settled without data. Never true while the read is in flight —
   * "we could not look" and "we have not looked yet" are different answers and
   * only one of them is worth telling somebody about.
   */
  unavailable: boolean;
  /** The underlying error, for surfacing a message. */
  error: unknown;
}

export function useSpaces(options: { enabled?: boolean } = {}): SpacesRead {
  const householdId = useActiveHouseholdId();
  const query = useQuery({
    queryKey: ['spaces', householdId],
    queryFn: spaceService.getSpaces,
    enabled: options.enabled ?? Boolean(householdId),
  });

  // `data` is deliberately NOT defaulted into the return value on a failure:
  // an empty list is only ever handed back alongside a status that says why.
  const spaces = query.status === 'success' ? query.data : EMPTY;
  const byId = useMemo(() => spaceMap(spaces), [spaces]);

  const status: SpacesStatus =
    query.status === 'error' ? 'unavailable' : query.status === 'success' ? 'ready' : 'loading';

  return { status, spaces, byId, unavailable: status === 'unavailable', error: query.error };
}

/** Stable identity so `byId` is not rebuilt on every render of a failed read. */
const EMPTY: PlantSpace[] = [];
