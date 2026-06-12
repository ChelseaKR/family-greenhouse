import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronUpDownIcon, PlusIcon } from '@heroicons/react/24/outline';
import { listMyHouseholds } from '@/services/householdService';
import { useAuthStore } from '@/store/authStore';
import { track } from '@/services/analytics';
import clsx from 'clsx';

/**
 * Compact household switcher — a `<details>` popover with the user's
 * memberships plus an "Add household" affordance, anchored above the
 * sidebar's user/sign-out block.
 *
 * Always visible when the user has at least one household (even with one),
 * so the "create another household" path is discoverable without diving
 * into settings.
 */
export function HouseholdSwitcher() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const activeHouseholdId = useAuthStore((s) => s.activeHouseholdId);
  const setActiveHouseholdId = useAuthStore((s) => s.setActiveHouseholdId);

  const { data: memberships } = useQuery({
    queryKey: ['me', 'households'],
    queryFn: listMyHouseholds,
    enabled: !!user,
    staleTime: 60_000,
  });

  if (!memberships || memberships.length === 0) return null;

  const activeId = activeHouseholdId ?? user?.householdId ?? memberships[0].householdId;
  const active = memberships.find((m) => m.householdId === activeId) ?? memberships[0];

  return (
    <details className="relative w-full group">
      <summary
        className={clsx(
          'list-none cursor-pointer rounded-md px-3 py-2 text-sm',
          'bg-primary-800 text-white hover:bg-primary-900',
          'flex items-center justify-between gap-2',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-white'
        )}
      >
        <span className="truncate">
          <span className="block text-xs text-primary-200">Active household</span>
          <span className="block font-medium">{active.name}</span>
        </span>
        <ChevronUpDownIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      </summary>
      <ul className="mt-1 space-y-1">
        {memberships.map((m) => (
          <li key={m.householdId}>
            <button
              type="button"
              className={clsx(
                'w-full text-left rounded-md px-3 py-2 text-sm',
                m.householdId === activeId
                  ? 'bg-primary-900 text-white'
                  : 'text-primary-100 hover:bg-primary-800'
              )}
              onClick={(e) => {
                setActiveHouseholdId(m.householdId === user?.householdId ? null : m.householdId);
                track('household_switched');
                // No blanket invalidation needed: every household-scoped
                // query key embeds the active household id (see
                // useActiveHouseholdId), so switching changes the keys
                // themselves — mounted queries refetch under the new
                // household and the old household's cache can never leak
                // into the new one. We only invalidate the new household's
                // entries so anything cached from a previous visit (within
                // its staleTime, e.g. api-keys/chat-budget) is refreshed.
                queryClient.invalidateQueries({
                  predicate: (q) => q.queryKey.includes(m.householdId),
                });
                (e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
              }}
            >
              {m.name} <span className="text-xs text-primary-200">({m.role})</span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="w-full flex min-h-touch items-center gap-2 rounded-md px-3 py-2 text-sm text-primary-100 hover:bg-primary-800 border border-primary-700 border-dashed"
            onClick={(e) => {
              (e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
              navigate('/onboarding?mode=add');
            }}
          >
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            Add a household
          </button>
        </li>
      </ul>
    </details>
  );
}
