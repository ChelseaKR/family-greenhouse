import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

  it('ignores an off-origin ?redirect (open-redirect guard)', async () => {
    server.use(handlers.authLoginOk);
    const user = userEvent.setup();
    renderLogin('/login?redirect=//evil.example.com');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // Falls back to the dashboard rather than honoring the protocol-relative URL.
    expect(await screen.findByText('Dashboard Page')).toBeInTheDocument();
  });

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
