import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { WaterDropIcon } from '@/components/icons/WaterDropIcon';
import { FertilizeIcon } from '@/components/icons/FertilizeIcon';
import { PruneIcon } from '@/components/icons/PruneIcon';
import { RepotIcon } from '@/components/icons/RepotIcon';
import { CustomTaskIcon } from '@/components/icons/CustomTaskIcon';

/**
 * The `taskTypeStyles` chip-mapping that TasksPage uses is a module-local
 * constant — not exported. Rather than render the full page (which would
 * pull in the auth store, react-query, the router, etc.) we exercise the
 * five icon components directly. They are the only collaborators that
 * `taskTypeStyles` introduces; the chip / iconColor strings are inert and
 * are visually verified upstream via the Playwright suite.
 */

const iconCases = [
  ['WaterDropIcon', WaterDropIcon],
  ['FertilizeIcon', FertilizeIcon],
  ['PruneIcon', PruneIcon],
  ['RepotIcon', RepotIcon],
  ['CustomTaskIcon', CustomTaskIcon],
] as const;

describe('TasksPage task-type icons', () => {
  it.each(iconCases)('%s renders as an inline <svg>', (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // All five icons are 32x32 viewBox botanicals.
    expect(svg?.getAttribute('viewBox')).toBe('0 0 32 32');
  });

  it.each(iconCases)('%s forwards className onto the rendered svg', (_name, Icon) => {
    const { container } = render(<Icon className="h-6 w-6 text-sky-700" />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    // Use the SVG-specific className.baseVal for SVGAnimatedString.
    const cls =
      (svg.className as unknown as SVGAnimatedString).baseVal ?? svg.getAttribute('class');
    expect(cls).toContain('h-6');
    expect(cls).toContain('w-6');
    expect(cls).toContain('text-sky-700');
  });

  it.each(iconCases)(
    '%s marks itself as aria-hidden so screen readers skip the decoration',
    (_name, Icon) => {
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    }
  );

  it('each icon uses currentColor for stroke so callers can recolor via text-*', () => {
    for (const [, Icon] of iconCases) {
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      unmount();
    }
  });
});
