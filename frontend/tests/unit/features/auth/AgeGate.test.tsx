import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AgeSignal } from '@/lib/ageSignal';

/**
 * The account gate in the app (features/auth/AgeGate.tsx): a store-reported
 * under-13 sees the notice instead of the form and is signed out; a missing
 * signal changes nothing.
 */
const age = vi.hoisted(() => ({
  signal: null as AgeSignal | null,
  register: vi.fn(async () => 'skipped' as const),
}));
vi.mock('@/services/nativeAgeRange', () => ({
  settledAgeSignal: () => age.signal,
  loadAgeSignal: async () => age.signal,
  onAgeSignal: () => () => undefined,
  registerAppTransactionIfMinor: age.register,
}));

import { AgeGate } from '@/features/auth/AgeGate';
import { useAuthStore } from '@/store/authStore';

const known = (bracket: 'under13' | 'age13to15' | 'age16to17' | 'adult'): AgeSignal => ({
  status: 'known',
  bracket,
  declaration: 'selfDeclared',
  minor: bracket !== 'adult',
});

function renderGate(holdWhilePending = false) {
  return render(
    <MemoryRouter>
      <AgeGate holdWhilePending={holdWhilePending}>
        <p>the sign-up form</p>
      </AgeGate>
    </MemoryRouter>
  );
}

beforeEach(() => {
  age.register.mockClear();
  useAuthStore.getState().logout();
});

describe('AgeGate', () => {
  it('shows the notice, with no way to enter another age, for a store-reported under-13', async () => {
    age.signal = known('under13');
    renderGate();
    expect(await screen.findByTestId('age-blocked-notice')).toBeInTheDocument();
    expect(screen.queryByText('the sign-up form')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /support@familygreenhouse\.net/ })).toBeInTheDocument();
  });

  it('signs a blocked person out', async () => {
    age.signal = known('under13');
    useAuthStore.setState({ isAuthenticated: true });
    renderGate();
    await screen.findByTestId('age-blocked-notice');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it.each(['age13to15', 'age16to17', 'adult'] as const)('lets %s through', (bracket) => {
    age.signal = known(bracket);
    renderGate();
    expect(screen.getByText('the sign-up form')).toBeInTheDocument();
  });

  it.each([
    'platformUnsupported',
    'notInScope',
    'declinedSharing',
    'requestFailed',
    'pluginMissing',
  ] as const)('a missing signal (%s) changes nothing', (reason) => {
    age.signal = { status: 'unavailable', reason };
    renderGate();
    expect(screen.getByText('the sign-up form')).toBeInTheDocument();
    expect(screen.queryByTestId('age-blocked-notice')).not.toBeInTheDocument();
  });

  it('holds a form back until the answer is in, when asked to', () => {
    age.signal = null;
    renderGate(true);
    expect(screen.queryByText('the sign-up form')).not.toBeInTheDocument();
  });
});
