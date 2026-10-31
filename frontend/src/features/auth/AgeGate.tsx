import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { AGE_ASSURANCE_POLICY } from '@/config/ageAssurance';
import { accountGate } from '@/lib/ageSignal';
import { registerAppTransactionIfMinor } from '@/services/nativeAgeRange';
import { useAgeSignal } from '@/hooks/useAgeSignal';
import { useAuthStore } from '@/store/authStore';

// Rendered only for a blocked person, so it is its own lazy chunk and the
// gate adds next to nothing to the entry bundle.
const AgeBlockedNotice = lazy(() => import('./AgeBlockedNotice'));

/**
 * Wraps sign-up, sign-in, invitation acceptance and every signed-in screen.
 *
 * When the store reports an age below the account policy's line: a signed-in
 * account is signed out on this device and the notice replaces the screen.
 * The notice offers no way to enter a different age (AB 1856 forbids
 * prompting a person to change their age information). A missing signal
 * blocks nothing (lib/ageSignal.ts).
 *
 * `holdWhilePending` keeps a form from rendering until the answer is in, for
 * the screens that create an account or a membership.
 */
export function AgeGate({
  children,
  holdWhilePending = false,
}: {
  children: ReactNode;
  holdWhilePending?: boolean;
}) {
  const signal = useAgeSignal();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const logout = useAuthStore((s) => s.logout);
  const gate = signal ? accountGate(signal, AGE_ASSURANCE_POLICY) : 'pending';

  useEffect(() => {
    if (gate === 'blocked' && isAuthenticated) logout();
  }, [gate, isAuthenticated, logout]);

  useEffect(() => {
    if (gate === 'allowed' && signal && isAuthenticated && userId) {
      void registerAppTransactionIfMinor(userId, signal);
    }
  }, [gate, signal, isAuthenticated, userId]);

  if (gate === 'blocked') {
    return (
      <Suspense fallback={null}>
        <AgeBlockedNotice />
      </Suspense>
    );
  }
  if (gate === 'pending' && holdWhilePending) return null;
  return <>{children}</>;
}
