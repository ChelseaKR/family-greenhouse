import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { LoginPage } from '@/features/auth/LoginPage';
import { useAuthStore } from '@/store/authStore';
import { server, handlers } from '../../msw/server';

function renderLogin(entry = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<div>Dashboard Page</div>} />
        <Route path="/shared/:code" element={<div>Shared Cutting Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('LoginPage', () => {
  it('keeps existing-account login and links to free registration', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign up free/i })).toHaveAttribute(
      'href',
      '/register'
    );
  });

  it('keeps deep-link intent when switching from login to registration', () => {
    renderLogin('/login?redirect=/join/code-1');

    expect(screen.getByRole('link', { name: /sign up free/i })).toHaveAttribute(
      'href',
      '/register?redirect=%2Fjoin%2Fcode-1'
    );
  });

  it('rejects invalid emails before submission', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
  });

  it('logs in and navigates to dashboard on success', async () => {
    server.use(handlers.authLoginOk);
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByText('Dashboard Page');
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.accessToken).toBe('access-1');
  });

  it('honors a same-origin ?redirect after login (graft-a-cutting loop)', async () => {
    server.use(handlers.authLoginOk);
    const user = userEvent.setup();
    renderLogin('/login?redirect=/shared/abc123');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // Lands back on the shared cutting card, not the default dashboard.
    expect(await screen.findByText('Shared Cutting Page')).toBeInTheDocument();
  });

  it.each(['//evil.example.com', '/%5Cevil.example.com', '/%255Cevil.example.com'])(
    'ignores an off-origin or backslash ?redirect: %s',
    async (redirect) => {
      server.use(handlers.authLoginOk);
      const user = userEvent.setup();
      renderLogin(`/login?redirect=${redirect}`);
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(screen.getByLabelText(/password/i), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      expect(await screen.findByText('Dashboard Page')).toBeInTheDocument();
    }
  );

  it('shows error message on bad credentials', async () => {
    server.use(handlers.authLoginOk);
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/invalid credentials/i);
    });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});

describe('LoginPage — two-step verification (#671)', () => {
  const API = 'http://localhost:4000';

  /**
   * A mock of the Cognito-backed contract: every password sign-in answers
   * with a NEW challenge session, and only `123456` against a live session
   * signs in. Sessions are spent by a failed attempt, as Cognito may do.
   */
  function mfaServer() {
    let issued = 0;
    const live = new Set<string>();
    const logins: string[] = [];
    const answers: Array<{ session: string; code: string }> = [];
    server.use(
      http.post(`${API}/auth/login`, async ({ request }) => {
        const body = (await request.json()) as { password: string };
        if (body.password !== 'password123') {
          return HttpResponse.json({ message: 'Invalid email or password' }, { status: 401 });
        }
        const session = `s-${++issued}`;
        live.add(session);
        logins.push(session);
        return HttpResponse.json({ challenge: 'SOFTWARE_TOKEN_MFA', session, username: 'u1' });
      }),
      http.post(`${API}/auth/login/mfa`, async ({ request }) => {
        const body = (await request.json()) as { session: string; code: string };
        answers.push(body);
        const wasLive = live.delete(body.session);
        if (!wasLive) {
          return HttpResponse.json(
            { message: 'expired', details: { code: 'MFA_SESSION_EXPIRED' } },
            { status: 401 }
          );
        }
        if (body.code !== '123456') {
          return HttpResponse.json(
            { message: 'mismatch', details: { code: 'INVALID_CODE' } },
            { status: 400 }
          );
        }
        return HttpResponse.json({
          user: {
            id: 'u1',
            email: 'test@example.com',
            name: 'Test',
            householdId: 'hh-1',
            householdRole: 'admin',
          },
          idToken: 'id-mfa',
          accessToken: 'access-mfa',
          refreshToken: 'refresh-mfa',
        });
      })
    );
    return { logins, answers };
  }

  async function passPasswordStep(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    return screen.findByRole('heading', { name: /two-step verification/i });
  }

  it('asks for the code instead of signing in, and focuses the code field', async () => {
    const calls = mfaServer();
    const user = userEvent.setup();
    renderLogin();
    await passPasswordStep(user);

    const field = screen.getByLabelText(/authentication code/i);
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(calls.answers).toHaveLength(0);
  });

  it('a wrong code is refused, and the retry uses a fresh challenge and signs in', async () => {
    const calls = mfaServer();
    const user = userEvent.setup();
    renderLogin();
    await passPasswordStep(user);

    await user.type(screen.getByLabelText(/authentication code/i), '000000');
    await user.click(screen.getByRole('button', { name: /verify code/i }));
    expect(await screen.findByText(/didn.t match/i)).toBeInTheDocument();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    await user.type(screen.getByLabelText(/authentication code/i), '123 456');
    await user.click(screen.getByRole('button', { name: /verify code/i }));
    await screen.findByText('Dashboard Page');

    // Second attempt ran against a NEW session, never the spent one.
    expect(calls.logins).toEqual(['s-1', 's-2']);
    expect(calls.answers.map((a) => a.session)).toEqual(['s-1', 's-2']);
    expect(calls.answers[1].code).toBe('123456');
    expect(useAuthStore.getState().accessToken).toBe('access-mfa');
  });

  it('rejects a malformed code without a request', async () => {
    const calls = mfaServer();
    const user = userEvent.setup();
    renderLogin();
    await passPasswordStep(user);

    await user.type(screen.getByLabelText(/authentication code/i), '12ab');
    await user.click(screen.getByRole('button', { name: /verify code/i }));
    expect(await screen.findByText(/enter the 6 digits/i)).toBeInTheDocument();
    expect(calls.answers).toHaveLength(0);
  });

  it('"Start over" returns to the password step', async () => {
    mfaServer();
    const user = userEvent.setup();
    renderLogin();
    await passPasswordStep(user);

    await user.click(screen.getByRole('button', { name: /start over/i }));
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/authentication code/i)).not.toBeInTheDocument();
  });
});
