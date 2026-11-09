import { QueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';

/**
 * The app's one query client, tied to the account it reads for.
 *
 * The cache lives in memory for as long as the tab does, and signing out is a
 * client-side navigation rather than a page load. So a sign-out used to leave
 * the last account's answers in place, and the next person to sign in on that
 * browser inherited them: `['me', 'households']` is not keyed by account, which
 * put the previous person's homes in the switcher, and choosing one showed that
 * home's cached plants, private notes included, without a request being made.
 *
 * Watching the store rather than editing `logout()` covers every way a session
 * ends: the sign-out button, a refused refresh, another tab signing out, account
 * deletion. A write that keeps the same account (a session check, a role change)
 * keeps the cache, and a first sign-in has nothing of anyone's to clear.
 */
export function createAppQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5 minutes
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });

  let accountId = useAuthStore.getState().user?.id ?? null;
  useAuthStore.subscribe((state) => {
    const nextAccountId = state.user?.id ?? null;
    if (accountId !== null && nextAccountId !== accountId) queryClient.clear();
    accountId = nextAccountId;
  });

  return queryClient;
}
