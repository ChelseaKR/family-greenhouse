import { Navigate } from 'react-router';
import { useAuthStore } from '@/store/authStore';
import { usePrefsStore } from '@/store/prefsStore';

/**
 * Where an authenticated visit to `/` actually lands.
 *
 * This exists because `/` is the join point of every path into the app that
 * matters here: household creation and invite-acceptance both finish with
 * `navigate('/')`, and the brand mark links there. Routing the decision
 * through one component means the first run is reachable from BOTH entry
 * points without either of those flows having to know it exists.
 *
 * Before this, `/` sent every authenticated user straight to `/dashboard`,
 * and nothing in the app ever navigated to `/welcome` — the first run was
 * unreachable outside of typing the URL.
 *
 * Deliberately cheap: no network reads, no suspense. Whether the first run
 * should actually run is a question about household state, and `WelcomeFlow`
 * answers it (see `decideFirstRun`) — including bouncing straight back to the
 * dashboard when the household turns out to be established. This component
 * only decides which of the two gets to ask.
 */
export function HomeRedirect() {
  const hasHousehold = useAuthStore((state) => state.user?.householdId != null);
  const welcomeSeen = usePrefsStore((state) => state.welcomeSeen);

  // No household yet: /dashboard's own gate forwards to /onboarding. Going
  // through it rather than hardcoding /onboarding keeps one owner for that
  // rule.
  if (!hasHousehold || welcomeSeen) return <Navigate to="/dashboard" replace />;

  return <Navigate to="/welcome" replace />;
}
