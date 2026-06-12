import { useAuthStore } from '@/store/authStore';

/**
 * The household every household-scoped request is actually served for:
 * the explicitly-switched household if one is active, otherwise the
 * Cognito-claim default household.
 *
 * Query-key convention: every household-scoped TanStack Query key embeds
 * this id as its SECOND element — ['plants', hh], ['tasks', hh, 'upcoming'],
 * ['api-keys', hh], ['household', hh, 'climate'], … — so switching
 * households changes the key itself. That makes cross-household cache
 * collisions impossible and removes the need for the HouseholdSwitcher to
 * enumerate (and inevitably miss) keys to invalidate.
 */
export function useActiveHouseholdId(): string | null {
  return useAuthStore((s) => s.activeHouseholdId ?? s.user?.householdId ?? null);
}
