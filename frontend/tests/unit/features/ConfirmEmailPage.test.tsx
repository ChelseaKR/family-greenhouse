import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ConfirmEmailPage } from '@/features/auth/ConfirmEmailPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import es from '@/i18n/locales/es/translation.json';
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
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('accepts an email to recover confirmation when router state is gone', async () => {
    let received: unknown;
    server.use(
      http.post(`${API}/auth/resend-code`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({ message: 'SERVER SUCCESS COPY' });
      })
    );
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email address/i), 'recover@example.com');
    await user.click(screen.getByRole('button', { name: /send confirmation code/i }));

    expect(
      await screen.findByText('A new confirmation code was sent. Check your email.')
    ).toBeInTheDocument();
    expect(screen.queryByText('SERVER SUCCESS COPY')).not.toBeInTheDocument();
    expect(received).toEqual({ email: 'recover@example.com' });
    expect(screen.getByText(/recover@example.com/i)).toBeInTheDocument();
  });

  it('keeps the sign-in escape hatch and safe redirect on recovery', () => {
    renderPage({ redirect: '/join/saved' });

    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fjoin%2Fsaved'
    );
  });

  it('restores pending confirmation context after a refresh', async () => {
    sessionStorage.setItem(
      'fg.pendingConfirmation',
      JSON.stringify({ email: 'saved@example.com', redirect: '/join/saved' })
    );
    renderPage();

    expect(screen.getByText(/saved@example.com/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirmation code/i)).toBeInTheDocument();
  });

  it('clicking Resend code calls the backend and shows a success notice', async () => {
    let received: unknown;
    server.use(
      http.post(`${API}/auth/resend-code`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({ message: 'SERVER SUCCESS COPY' });
      })
    );
    renderPage({ email: 'a@b.com' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /resend code/i }));
    expect(
      await screen.findByText('A new confirmation code was sent. Check your email.')
    ).toBeInTheDocument();
    expect(screen.queryByText('SERVER SUCCESS COPY')).not.toBeInTheDocument();
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

  it('drops a backslash redirect before routing from confirmation to login', async () => {
    server.use(
      http.post(`${API}/auth/confirm`, () => HttpResponse.json({ message: 'Email confirmed' }))
    );
    renderPage({ email: 'a@b.com', redirect: '/\\evil.example' });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/confirmation code/i), '123456');
    await user.click(screen.getByRole('button', { name: /confirm email/i }));

    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(screen.getByText('redirect:none')).toBeInTheDocument();
  });

  it('rejects a nonnumeric confirmation code before calling the API', async () => {
    let confirmCalls = 0;
    server.use(
      http.post(`${API}/auth/confirm`, () => {
        confirmCalls += 1;
        return HttpResponse.json({ message: 'Email confirmed' });
      })
    );
    renderPage({ email: 'a@b.com' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/confirmation code/i), '12ab56');
    await user.click(screen.getByRole('button', { name: /confirm email/i }));

    expect(await screen.findByText(/confirmation code must be 6 digits/i)).toBeInTheDocument();
    expect(confirmCalls).toBe(0);
  });

  it('localizes the full register, confirm, and login handoff in Spanish', async () => {
    const spanish = createInstance();
    await spanish.init({
      lng: 'es',
      fallbackLng: 'es',
      resources: { es: { translation: es } },
      interpolation: { escapeValue: false },
    });
    server.use(
      http.post(`${API}/auth/signup`, () =>
        HttpResponse.json({ message: 'Revisa tu correo' }, { status: 201 })
      ),
      http.post(`${API}/auth/resend-code`, () =>
        HttpResponse.json({ message: 'ENGLISH SERVER SUCCESS' })
      ),
      http.post(`${API}/auth/confirm`, () => HttpResponse.json({ message: 'Correo confirmado' }))
    );
    render(
      <I18nextProvider i18n={spanish}>
        <MemoryRouter initialEntries={['/register']}>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/confirm-email" element={<ConfirmEmailPage />} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    );
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: /empieza tu invernadero/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/nombre completo/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/correo electrónico/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^contraseña\s*\*?$/i), 'Password1234');
    await user.type(screen.getByLabelText(/confirmar contraseña/i), 'Password1234');
    await user.click(screen.getByRole('button', { name: /crear una cuenta/i }));

    expect(await screen.findByRole('heading', { name: /confirma tu correo/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reenviar código/i }));
    expect(
      await screen.findByText(/enviamos un código de confirmación nuevo/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('ENGLISH SERVER SUCCESS')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/código de confirmación/i), '123456');
    await user.click(screen.getByRole('button', { name: /confirmar correo/i }));

    expect(
      await screen.findByRole('heading', { name: /te damos la bienvenida/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/correo confirmado/i);
    expect(screen.getByDisplayValue('ada@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /olvidaste tu contraseña/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /iniciar sesión/i })).toBeInTheDocument();
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
