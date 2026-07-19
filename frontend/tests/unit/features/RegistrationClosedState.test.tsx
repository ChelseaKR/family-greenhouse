import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/config/commercialStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
  PUBLIC_REGISTRATION_AVAILABLE: false,
}));

import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';

describe('public registration emergency-off state', () => {
  it('removes the login acquisition link', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    expect(screen.queryByRole('link', { name: /sign up free/i })).not.toBeInTheDocument();
    expect(screen.getByText(/registration is currently paused/i)).toBeInTheDocument();
  });

  it('fails closed on /register without contradicting the paused state', () => {
    render(
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /create account/i })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/registration is currently paused/i);
    expect(screen.queryByText(/registration is open/i)).not.toBeInTheDocument();
  });
});
