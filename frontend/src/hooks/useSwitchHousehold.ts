import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { track } from '@/services/analytics';

/**
 * Makes another of the user's households the active one. Shared by the
 * drawer's HouseholdSwitcher and the iOS app's native More list.
 */
export function useSwitchHousehold(): (householdId: string) => void {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setActiveHouseholdId = useAuthStore((s) => s.setActiveHouseholdId);
  return useCallback(
    (householdId: string) => {
      setActiveHouseholdId(householdId === user?.householdId ? null : householdId);
      track('household_switched');
      // No blanket invalidation needed: every household-scoped
      // query key embeds the active household id (see
      // useActiveHouseholdId), so switching changes the keys
      // themselves — mounted queries refetch under the new
      // household and the old household's cache can never leak
      // into the new one. We only invalidate the new household's
      // entries so anything cached from a previous visit (within
      // its staleTime, e.g. api-keys/chat-budget) is refreshed.
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey.includes(householdId),
      });
    },
    [queryClient, setActiveHouseholdId, user?.householdId]
  );
}
