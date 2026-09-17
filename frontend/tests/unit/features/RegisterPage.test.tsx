import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { track } from '@/services/analytics';
import { server } from '../../msw/server';
import { getPendingReferralCode } from '@/features/referrals/pendingReferralCode';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});

const API = 'http://localhost:4000';

describe('RegisterPage', () => {
  function renderPage(entry = '/register') {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <RegisterPage />
      </MemoryRouter>
    );
  }

  it('renders the free-account signup form and existing-account sign-in', () => {
    renderPage();

    expect(
      screen.getByRole('heading', { level: 1, name: /start your greenhouse/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/free for one home, up to 3 household members and 20 plants/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password\s*\*?$/i)).toHaveAttribute('minlength', '12');
    expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  it('keeps deep-link intent when switching from registration to login', () => {
    renderPage('/register?redirect=/shared/cutting-1');

    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fshared%2Fcutting-1'
    );
  });

  it.each(['/%5Cevil.example', '/%255Cevil.example'])(
    'does not carry an encoded backslash redirect into login: %s',
    (redirect) => {
      renderPage(`/register?redirect=${redirect}`);

      expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    }
  );

  it.each([
    ['blank after trimming', '   ', /at least 2 characters/i],
    ['over 100 characters', 'a'.repeat(101), /100 characters or fewer/i],
  ])('rejects a name that is %s before signup', async (_case, name, errorText) => {
    let signupCalls = 0;
    server.use(
      http.post(`${API}/auth/signup`, () => {
        signupCalls += 1;
        return HttpResponse.json({ message: 'Check your email' }, { status: 201 });
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/full name/i), name);
    await user.type(screen.getByLabelText(/email address/i), 'valid@example.com');
    await user.type(screen.getByLabelText(/^password\s*\*?$/i), 'Password1234');
    await user.type(screen.getByLabelText(/confirm password/i), 'Password1234');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(errorText)).toBeInTheDocument();
    expect(signupCalls).toBe(0);
  });

  it('trims the submitted display name', async () => {
    let received: unknown;
    server.use(
      http.post(`${API}/auth/signup`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({ message: 'Check your email' }, { status: 201 });
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/full name/i), '  Ada Lovelace  ');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^password\s*\*?$/i), 'Password1234');
    await user.type(screen.getByLabelText(/confirm password/i), 'Password1234');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(received).toEqual({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'Password1234',
      });
    });
  });

  it('reports the sign-up as started only once the API has accepted the account', async () => {
    // The first funnel stage (docs/analytics.md). A refused sign-up is not a
    // sign-up started, so the event must wait for the 201.
    vi.mocked(track).mockClear();
    server.use(
      http.post(`${API}/auth/signup`, () =>
        HttpResponse.json({ message: 'An account with this email already exists' }, { status: 400 })
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/full name/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^password\s*\*?$/i), 'Password1234');
    await user.type(screen.getByLabelText(/confirm password/i), 'Password1234');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(track).not.toHaveBeenCalled();

    server.use(
      http.post(`${API}/auth/signup`, () =>
        HttpResponse.json({ message: 'Check your email' }, { status: 201 })
      )
    );
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(track).toHaveBeenCalledWith('signup_started'));
    expect(track).toHaveBeenCalledTimes(1);
  });

  describe('refer-a-friend (ADR 0029)', () => {
    it('does not show the referred notice, and stashes nothing, on an ordinary visit', () => {
      sessionStorage.clear();
      renderPage('/register');
      expect(screen.queryByText(/invited to family greenhouse/i)).not.toBeInTheDocument();
      expect(getPendingReferralCode()).toBeNull();
    });

    it('shows the referred notice and stashes the code from ?ref= for HouseholdOnboarding to pick up', () => {
      sessionStorage.clear();
      renderPage('/register?ref=RF-00000-00001');
      expect(screen.getByText(/invited to family greenhouse/i)).toBeInTheDocument();
      // Stashed exactly as given — normalization/validation is the server's
      // job (services/referrals.ts), never re-implemented on the client.
      expect(getPendingReferralCode()).toBe('RF-00000-00001');
    });
  });
});
