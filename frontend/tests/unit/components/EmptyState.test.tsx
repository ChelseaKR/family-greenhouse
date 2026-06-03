import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '@/components/EmptyState';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState title="Nothing here yet" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing here yet' })).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="Empty" description="Add your first plant to begin." />);
    expect(screen.getByText('Add your first plant to begin.')).toBeInTheDocument();
  });

  it('omits description paragraph when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByText(/add your first plant/i)).not.toBeInTheDocument();
  });

  it('renders action when provided', () => {
    render(<EmptyState title="Empty" action={<button type="button">Add plant</button>} />);
    expect(screen.getByRole('button', { name: 'Add plant' })).toBeInTheDocument();
  });

  it('renders the icon when provided', () => {
    render(<EmptyState title="Empty" icon={<svg data-testid="illustration" />} />);
    expect(screen.getByTestId('illustration')).toBeInTheDocument();
  });

  it('icon wrapper does NOT carry the old h-12 w-12 clipping classes (regression)', () => {
    render(<EmptyState title="Empty" icon={<svg data-testid="illustration" />} />);
    const icon = screen.getByTestId('illustration');
    const wrapper = icon.parentElement as HTMLElement;
    expect(wrapper).not.toBeNull();
    // The bug: a `h-12 w-12` wrapper clipped the illustration. The fix
    // removes those fixed sizes so the SVG sizes itself via its own
    // className.
    expect(wrapper.className).not.toMatch(/\bh-12\b/);
    expect(wrapper.className).not.toMatch(/\bw-12\b/);
  });

  it('icon wrapper is not rendered when no icon is provided', () => {
    const { container } = render(<EmptyState title="Empty" />);
    // The icon wrapper is the only `aria-hidden="true"` div in the
    // component, so when there's no icon there should be none.
    const ariaHidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(ariaHidden.length).toBe(0);
  });

  it('icon wrapper has aria-hidden=true so screen readers skip decorative art', () => {
    render(<EmptyState title="Empty" icon={<svg data-testid="illustration" />} />);
    const wrapper = screen.getByTestId('illustration').parentElement;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  });
});
