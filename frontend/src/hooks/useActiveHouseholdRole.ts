import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { listMyHouseholds } from '@/services/householdService';
import { useActiveHouseholdId } from './useActiveHouseholdId';

/**
 * The caller's role IN THE ACTIVE household — the authoritative source for
 * admin gating.
 *
 * `user.householdRole` is ONLY the Cognito-claim DEFAULT household's role, so
 * after switching to another household (where the user may be a plain member)
 * it is wrong: admin-only controls would render for a non-admin and the
 * resulting mutation 403s (a 403 the auth interceptor can't recover from), or
 * an actual admin of a non-default household loses their controls. The backend
 * resolves role from the membership row of the active household; the per-
 * household roles the client has live in the `/me/households` list.
 *
 * Falls back to the claim role while that list loads (correct for the default
 * household and avoids an admin-UI flicker); the list is staleTime-cached and
 * loaded app-wide by the HouseholdSwitcher.
 */
export function useActiveHouseholdRole(): 'admin' | 'member' | null {
  const activeId = useActiveHouseholdId();
  const claimRole = useAuthStore((s) => s.user?.householdRole ?? null);
  const enabled = useAuthStore((s) => !!s.user);
  const { data: memberships } = useQuery({
    queryKey: ['me', 'households'],
    queryFn: listMyHouseholds,
    enabled,
    staleTime: 60_000,
  });
  return memberships?.find((m) => m.householdId === activeId)?.role ?? claimRole;
}

/** True iff the caller is an admin of the ACTIVE household. */
export function useIsHouseholdAdmin(): boolean {
  return useActiveHouseholdRole() === 'admin';
}
