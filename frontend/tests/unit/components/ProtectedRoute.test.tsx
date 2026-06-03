import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuthStore } from '@/store/authStore';

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/secret']}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/secret" element={<div>Secret Stuff</div>} />
        </Route>
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  it('shows the spinner while auth is loading', () => {
    useAuthStore.setState({
      isAuthenticated: false,
      isLoading: true,
      user: null,
      accessToken: null,
      refreshToken: null,
    });
    renderRoute();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('redirects unauthenticated users to /login', () => {
    useAuthStore.setState({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      accessToken: null,
      refreshToken: null,
    });
    renderRoute();
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('renders the outlet for authenticated users', () => {
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      user: {
        id: 'u',
        email: 'e',
        name: 'n',
        householdId: 'hh',
        householdRole: 'admin',
      },
      accessToken: 'a',
      refreshToken: 'r',
    });
    renderRoute();
    expect(screen.getByText('Secret Stuff')).toBeInTheDocument();
  });
});
