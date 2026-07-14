import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { ConfirmEmailPage } from '@/features/auth/ConfirmEmailPage';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/** Stand-in for the real LoginPage that surfaces the redirect query + the
 *  justConfirmed/email handoff state, so tests can assert the confirm→login
 *  routing carries them. */
function LoginLanding() {
  const [params] = useSearchParams();
  const state = useLocation().state as { justConfirmed?: boolean; email?: string } | null;
  return (
    <div>
      Login Page
      <span>redirect:{params.get('redirect') ?? 'none'}</span>
      {state?.justConfirmed && <span>confirmed:{state.email}</span>}
    </div>
  );
}

function renderPage(state?: { email?: string; redirect?: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/confirm-email', state: state ?? null }]}>
      <Routes>
        <Route path="/confirm-email" element={<ConfirmEmailPage />} />
        <Route path="/onboarding" element={<div>Onboarding Page</div>} />
        <Route path="/login" element={<LoginLanding />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ConfirmEmailPage', () => {
  it('shows hold status and existing-account sign-in when no confirmation is in progress', () => {
    renderPage();
    expect(screen.getByText(/no email address provided/i)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /new registration and commercial activity are paused/i,
      })
    ).toBeInTheDocument();
    expect(document.querySelector('a[href^="/register"]')).toBeNull();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  it('clicking Resend code calls the backend and shows a success notice', async () => {
    let received: unknown;
    server.use(
      http.post(`${API}/auth/resend-code`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({ message: 'Code resent' });
      })
    );
    renderPage({ email: 'a@b.com' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /resend code/i }));
    expect(await screen.findByText('Code resent')).toBeInTheDocument();
    expect(received).toEqual({ email: 'a@b.com' });
  });

  it('confirms then routes to login (no token reading), preserving the invite redirect', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/auth/confirm`, async ({ request }) => {
        body = await request.json();
        // confirmSignUp returns only a message — NO tokens.
        return HttpResponse.json({ message: 'Email confirmed' });
      })
    );
    renderPage({ email: 'a@b.com', redirect: '/join/code-1' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/confirmation code/i), '123456');
    await user.click(screen.getByRole('button', { name: /confirm email/i }));

    // Lands on /login (not /onboarding), carrying the redirect + email handoff.
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(screen.getByText('redirect:/join/code-1')).toBeInTheDocument();
    expect(screen.getByText('confirmed:a@b.com')).toBeInTheDocument();
    expect(body).toEqual({ email: 'a@b.com', code: '123456' });
  });

  it('shows an error alert if resend fails', async () => {
    server.use(
      http.post(`${API}/auth/resend-code`, () =>
        HttpResponse.json({ message: 'Too many requests' }, { status: 429 })
      )
    );
    renderPage({ email: 'a@b.com' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /resend code/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many/i);
  });
});
