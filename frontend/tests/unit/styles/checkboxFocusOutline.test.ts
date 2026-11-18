import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The app's focus indicator is a ring, which is a box-shadow. WebKit does not
 * paint a box-shadow on a checkbox or radio it draws itself, and the same
 * rule removes the browser's own outline. So in Safari, and in the iPhone app
 * with a keyboard attached, tabbing to "Keep me signed in" or to any
 * notification setting showed no focus indicator at all (WCAG 2.4.7). Seen in
 * Playwright WebKit: `:focus-visible` matched, box-shadow computed to `none`,
 * outline-style `none`.
 *
 * The e2e keyboard checks run in WebKit only in the weekly cross-browser
 * sweep, so the rule that fixes it is pinned here for every PR.
 */
const css = readFileSync(resolve(__dirname, '../../../src/index.css'), 'utf8');

describe('checkbox and radio focus indicator', () => {
  const rule =
    /input\[type='checkbox'\]:focus-visible,\s*input\[type='radio'\]:focus-visible\s*{([^}]*)}/.exec(
      css
    );

  it('is an outline, which every engine paints on a native control', () => {
    expect(rule, "index.css: input[type='checkbox']:focus-visible, … { outline … }").not.toBeNull();
    const outline = /outline:\s*([\d.]+)px\s+solid\s+var\(--color-(primary-\d+)\)/.exec(rule![1]);
    expect(outline).not.toBeNull();
    // At least as thick as the ring it stands in for.
    expect(Number(outline![1])).toBeGreaterThanOrEqual(2);
    // The same colour as the ring (3.4:1 on white).
    expect(outline![2]).toBe('primary-500');
    expect(rule![1]).toMatch(/outline-offset:\s*2px/);
  });

  it('comes after the base focus rule, whose outline-hidden it has to override', () => {
    const base = css.indexOf(':focus-visible {');
    expect(base).toBeGreaterThan(-1);
    expect(rule!.index).toBeGreaterThan(base);
  });
});
