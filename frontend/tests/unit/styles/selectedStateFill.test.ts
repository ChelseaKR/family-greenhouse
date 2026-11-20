import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 1.4.1 Use of Color and 1.4.11 Non-text Contrast, for the selected view
 * toggles and filter chips.
 *
 * A selected chip or toggle used to differ from the others by a pale tint
 * (`primary-100` or `primary-50`, 1.1:1 against the page) and, on chips, a
 * `primary-400` border (about 2.5:1). It is now filled `primary-700` with
 * white text, as the plant-name vibes and the billing-interval switch already
 * were (owner decision 2026-11-20, option C "Fill"). This pins the fill on
 * every such control and measures it.
 */
const SRC = resolve(__dirname, '../../../src');
const css = readFileSync(join(SRC, 'index.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  if (!match) throw new Error(`index.css has no --color-${name}`);
  return match[1];
}

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

/** Each control's file, and how many selected branches it has. */
const CONTROLS: ReadonlyArray<[file: string, selected: number, what: string]> = [
  ['features/tasks/TasksPage.tsx', 3, 'By date / Care round, and the filter chips'],
  ['features/tasks/TaskChecklist.tsx', 1, 'the Today / Upcoming segments'],
  ['features/plants/PlantsPage.tsx', 2, 'the view buttons and the space chips'],
  ['features/dashboard/DashboardPage.tsx', 1, 'the activity chips'],
  ['features/plants/SpacePicker.tsx', 1, 'the Inside / Outside chips'],
];

describe('selected toggles and chips are filled', () => {
  it.each(CONTROLS)('%s: %s', (file, selected) => {
    const source = readFileSync(join(SRC, file), 'utf8');
    // The selected branch of each `x === y ? '<selected>' : '<other>'`.
    const branches = [...source.matchAll(/===\s*[\w.'"]+\s*\?\s*'([^']*)'/g)].map((m) => m[1]);
    const filled = branches.filter((b) => /\bbg-primary-700\b/.test(b) && /\btext-white\b/.test(b));
    expect(filled.length, `${file}: selected branches filled primary-700 / white`).toBe(selected);
    for (const branch of branches) {
      expect(branch, `${file}: a selected branch still uses the tint`).not.toMatch(
        /\bbg-primary-(50|100)\b/
      );
    }
  });

  it('the fill stands apart from the page by more than 3:1', () => {
    expect(contrast(token('primary-700'), token('paper'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('primary-700'), '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('the white text on the fill reaches 4.5:1', () => {
    expect(contrast('#ffffff', token('primary-700'))).toBeGreaterThanOrEqual(4.5);
  });
});
