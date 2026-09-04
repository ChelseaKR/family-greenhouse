import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { listMyHouseholds } from '@/services/householdService';
import { useActiveHouseholdId } from './useActiveHouseholdId';

/**
 * The ACTIVE household's display name, or `null` while the membership list
 * is loading, failed, or does not know the household. Reads the same
 * `/me/households` list the switcher and `useActiveHouseholdRole` already
 * cache, so it costs no extra request.
 *
 * `null` is the honest answer, not an empty string: callers that print the
 * name (a share line, an email subject) must fall back to a generic phrase
 * rather than a blank.
 */
export function useActiveHouseholdName(): string | null {
  const activeId = useActiveHouseholdId();
  const enabled = useAuthStore((s) => !!s.user);
  const { data: memberships } = useQuery({
    queryKey: ['me', 'households'],
    queryFn: listMyHouseholds,
    enabled,
    staleTime: 60_000,
  });
  const name = memberships?.find((m) => m.householdId === activeId)?.name?.trim();
  return name ? name : null;
}
