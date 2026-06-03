import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConfirmEmailPage } from '@/features/auth/ConfirmEmailPage';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderPage(state?: { email?: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/confirm-email', state: state ?? null }]}>
      <Routes>
        <Route path="/confirm-email" element={<ConfirmEmailPage />} />
        <Route path="/onboarding" element={<div>Onboarding Page</div>} />
        <Route path="/register" element={<div>Register Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ConfirmEmailPage', () => {
  it('redirects unprovided email to a "go register" prompt', () => {
    renderPage();
    expect(screen.getByText(/no email address provided/i)).toBeInTheDocument();
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
