import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardHeader } from '@/components/Card';

describe('Card', () => {
  it('renders children', () => {
    render(
      <Card>
        <p>Inside card</p>
      </Card>
    );
    expect(screen.getByText('Inside card')).toBeInTheDocument();
  });

  it('defaults to the solid variant with white background + card shadow', () => {
    const { container } = render(
      <Card>
        <span>x</span>
      </Card>
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div).toHaveClass('bg-white', 'shadow-card');
    // And NOT paper / journal classes.
    expect(div).not.toHaveClass('bg-paper');
    expect(div).not.toHaveClass('shadow-journal');
  });

  it('applies paper variant classes', () => {
    const { container } = render(
      <Card variant="paper">
        <span>x</span>
      </Card>
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div).toHaveClass('bg-paper', 'shadow-journal');
    expect(div).not.toHaveClass('bg-white');
  });

  it('applies journal variant classes (no shadow, bottom rule)', () => {
    const { container } = render(
      <Card variant="journal">
        <span>x</span>
      </Card>
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div).toHaveClass('bg-paper', 'border-b', 'rounded-none');
    expect(div).not.toHaveClass('shadow-journal');
    expect(div).not.toHaveClass('shadow-card');
  });

  it('applies the correct padding class for each padding size', () => {
    const cases: Array<['none' | 'sm' | 'md' | 'lg', string | null]> = [
      ['none', null],
      ['sm', 'p-4'],
      ['md', 'p-6'],
      ['lg', 'p-8'],
    ];

    for (const [padding, expected] of cases) {
      const { container, unmount } = render(
        <Card padding={padding}>
          <span>x</span>
        </Card>
      );
      const div = container.firstElementChild as HTMLElement;
      if (expected) {
        expect(div).toHaveClass(expected);
      } else {
        // none should not pick up p-4/p-6/p-8.
        expect(div.className).not.toMatch(/\bp-[468]\b/);
      }
      unmount();
    }
  });

  it('forwards className', () => {
    const { container } = render(
      <Card className="custom-card">
        <span>x</span>
      </Card>
    );
    expect(container.firstElementChild).toHaveClass('custom-card');
  });
});

describe('CardHeader', () => {
  it('renders title', () => {
    render(<CardHeader title="Section title" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Section title' })).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<CardHeader title="Title" description="A short note" />);
    expect(screen.getByText('A short note')).toBeInTheDocument();
  });

  it('omits description when not provided', () => {
    render(<CardHeader title="Title" />);
    expect(screen.queryByText('A short note')).not.toBeInTheDocument();
  });

  it('renders action when provided', () => {
    render(<CardHeader title="Title" action={<button type="button">Add</button>} />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('omits action wrapper when no action is provided', () => {
    render(<CardHeader title="Title" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
