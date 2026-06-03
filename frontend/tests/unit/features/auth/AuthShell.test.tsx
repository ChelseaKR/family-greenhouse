import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthShell } from '@/features/auth/AuthShell';

function renderShell(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('AuthShell', () => {
  it('renders the title heading', () => {
    renderShell(
      <AuthShell title="Welcome back">
        <p>form goes here</p>
      </AuthShell>
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });

  it('renders children inside the shell card', () => {
    renderShell(
      <AuthShell title="Welcome back">
        <p>form goes here</p>
      </AuthShell>
    );
    expect(screen.getByText('form goes here')).toBeInTheDocument();
  });

  it('renders a string subtitle when provided', () => {
    renderShell(
      <AuthShell title="Welcome" subtitle="Sign in to continue">
        <p>x</p>
      </AuthShell>
    );
    expect(screen.getByText('Sign in to continue')).toBeInTheDocument();
  });

  it('supports a ReactNode subtitle (e.g. nested <strong>)', () => {
    renderShell(
      <AuthShell
        title="Check your email"
        subtitle={
          <>
            code sent to <strong>user@example.com</strong>
          </>
        }
      >
        <p>x</p>
      </AuthShell>
    );
    expect(screen.getByText(/code sent to/i)).toBeInTheDocument();
    const strong = screen.getByText('user@example.com');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders the footer slot below the card when provided', () => {
    renderShell(
      <AuthShell title="Welcome" footer={<span>Need an account? Register.</span>}>
        <p>x</p>
      </AuthShell>
    );
    expect(screen.getByText(/need an account/i)).toBeInTheDocument();
  });

  it('omits the footer when not provided', () => {
    renderShell(
      <AuthShell title="Welcome">
        <p>x</p>
      </AuthShell>
    );
    expect(screen.queryByText(/need an account/i)).not.toBeInTheDocument();
  });

  it('brand wordmark links to /', () => {
    renderShell(
      <AuthShell title="Welcome">
        <p>x</p>
      </AuthShell>
    );
    const link = screen.getByRole('link', { name: /family greenhouse home/i });
    expect(link).toHaveAttribute('href', '/');
    // The wordmark text + tagline should be inside that link.
    expect(link).toHaveTextContent('Family Greenhouse');
    expect(link).toHaveTextContent(/grow together/i);
  });

  it('renders both decorative corner sprigs and hides them on mobile (hidden md:block)', () => {
    const { container } = renderShell(
      <AuthShell title="Welcome">
        <p>x</p>
      </AuthShell>
    );
    // The corner sprigs are the only `absolute pointer-events-none` SVGs
    // in the shell — the TitleUnderline (also aria-hidden) is inline, not
    // absolutely positioned.
    const sprigs = container.querySelectorAll('svg.pointer-events-none.absolute');
    expect(sprigs.length).toBe(2);
    sprigs.forEach((sprig) => {
      expect(sprig).toHaveClass('hidden');
      const cls =
        (sprig.className as unknown as SVGAnimatedString).baseVal ?? sprig.getAttribute('class');
      expect(cls).toContain('md:block');
    });
  });
});
