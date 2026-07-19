import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

describe('ResetPasswordPage', () => {
  function renderPage() {
    return render(
      <MemoryRouter
        initialEntries={[{ pathname: '/reset-password', state: { email: 'ada@example.com' } }]}
      >
        <ResetPasswordPage />
      </MemoryRouter>
    );
  }

  it('rejects a password below Cognito policy before calling the API', async () => {
    let resetCalls = 0;
    server.use(
      http.post(`${API}/auth/reset-password`, () => {
        resetCalls += 1;
        return HttpResponse.json({ message: 'Password reset' });
      })
    );
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/reset code/i), '123456');
    await user.type(screen.getByLabelText(/^new password/i), 'Password123');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Password123');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(resetCalls).toBe(0);
  });

  it('rejects a nonnumeric reset code before calling the API', async () => {
    let resetCalls = 0;
    server.use(
      http.post(`${API}/auth/reset-password`, () => {
        resetCalls += 1;
        return HttpResponse.json({ message: 'Password reset' });
      })
    );
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/reset code/i), '12ab56');
    await user.type(screen.getByLabelText(/^new password/i), 'Password1234');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Password1234');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText(/reset code must be 6 digits/i)).toBeInTheDocument();
    expect(resetCalls).toBe(0);
  });
});
