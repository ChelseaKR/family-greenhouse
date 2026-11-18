import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 1.4.11 Non-text Contrast: the visual boundary of a control needs 3:1
 * against what is next to it. A text field here has the page's own colour for
 * a fill, so its border is the only thing that says where it is. That border
 * was `primary-200`, 1.5:1 on white: a person with low vision saw labels and
 * placeholder text floating on the page, with no boxes to type in.
 * docs/accessibility.md already said the borders were 3:1; nothing checked.
 *
 * axe cannot see this (it measures text, not borders), so the rule is pinned
 * here from the tokens in index.css.
 */
const css = readFileSync(resolve(__dirname, '../../../src/index.css'), 'utf8');

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `--color-<name>: #rrggbb` from the @theme block, or Tailwind's own red. */
function token(name: string): string {
  const own = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  if (own) return own[1];
  // Tailwind v4's palette, which index.css does not override for red.
  const tailwind: Record<string, string> = { 'red-600': '#e7000b', 'red-300': '#ffa2a2' };
  expect(tailwind[name], `no colour known for ${name}`).toBeDefined();
  return tailwind[name];
}

/** The border colour class a component rule applies, e.g. `primary-500`. */
function borderOf(selector: string): string {
  const rule = new RegExp(`\\.${selector}\\s*{[^}]*@apply([^;]*);`).exec(css);
  expect(rule, `index.css: .${selector} { @apply … }`).not.toBeNull();
  const border = /(?:^|\s)border-([a-z]+-\d{2,3})(?=\s|$)/.exec(rule![1]);
  expect(border, `.${selector} sets a border colour`).not.toBeNull();
  return border![1];
}

describe('text field borders can be seen', () => {
  const surfaces = { white: '#ffffff', paper: token('paper') };

  it.each(Object.entries(surfaces))('.input border is at least 3:1 on %s', (_name, surface) => {
    expect(contrast(token(borderOf('input')), surface)).toBeGreaterThanOrEqual(3);
  });

  it.each(Object.entries(surfaces))(
    '.input-error border is at least 3:1 on %s',
    (_name, surface) => {
      expect(contrast(token(borderOf('input-error')), surface)).toBeGreaterThanOrEqual(3);
    }
  );

  it('measures contrast the way WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    // The border this replaced, for the record.
    expect(contrast('#c0dd97', '#ffffff')).toBeLessThan(1.6);
  });
});
