import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Forced colors (Windows High Contrast) discards the page's backgrounds. The
 * selected view toggle, a pressed filter chip, the open settings tab and the
 * current page in the sidebar were marked by a background tint and nothing
 * else, so with forced colors on, the selected one could not be told from the
 * rest (seen in Chromium with forced-colors emulated: "By date" and "Care
 * round" drew identically). WCAG 1.4.1 Use of Color, 1.4.11 Non-text Contrast.
 *
 * jsdom has no forced-colors mode, so the rule is pinned from index.css.
 */
const css = readFileSync(resolve(__dirname, '../../../src/index.css'), 'utf8');

describe('selected state in forced colors', () => {
  const block = /@media \(forced-colors: active\)\s*{([\s\S]*?)\n  }\n/.exec(css);

  it('has a forced-colors block', () => {
    expect(block, 'index.css: @media (forced-colors: active) { … }').not.toBeNull();
  });

  it.each(["[aria-pressed='true']", "[aria-current='page']", "[role='tab'][aria-selected='true']"])(
    '%s takes the system selection colours',
    (selector) => {
      const body = block![1];
      const rule = /([^{}]*){([^}]*)}/.exec(body);
      expect(rule).not.toBeNull();
      expect(rule![1]).toContain(selector);
      expect(rule![2]).toMatch(/background-color:\s*Highlight\s*!important/);
      expect(rule![2]).toMatch(/color:\s*HighlightText\s*!important/);
      // Without this the browser repaints the background it was just given.
      expect(rule![2]).toMatch(/forced-color-adjust:\s*none\s*!important/);
    }
  );

  it('gives the filled .btn classes an edge, since their fill is gone', () => {
    expect(block![1]).toMatch(
      /\.btn-primary,\s*\.btn-danger\s*{[^}]*border:\s*1px solid ButtonBorder\s*!important/
    );
  });

  it('carries the text colour to what is inside, icons and count badges included', () => {
    expect(block![1]).toMatch(
      /\[aria-pressed='true'\] \*,[\s\S]*{[^}]*color:\s*HighlightText\s*!important/
    );
  });
});
