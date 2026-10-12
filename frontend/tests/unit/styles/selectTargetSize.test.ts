import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Safari on the Mac draws a `<select>` at its own native height and ignores
 * padding, so selects came out 18 to 23px tall there, under the 24px minimum
 * target size that tests/e2e/responsive-ux.spec.ts checks. That spec runs
 * WebKit only in the weekly cross-browser sweep, so this pins the rule that
 * fixes it in every PR: selects drawn by the app (Safari ignores min-height
 * on a native pop-up button) with a min-height of at least 24px. The e2e
 * check measures the real result.
 */
const css = readFileSync(resolve(__dirname, '../../../src/index.css'), 'utf8');

describe('select target size', () => {
  const rule = /@layer base\s*{\s*select:not\(\[multiple\]\):not\(\[size\]\)\s*{([^}]*)}\s*}/.exec(
    css
  );

  it('every single-line select is drawn by the app, not as a native pop-up', () => {
    expect(
      rule,
      'index.css: @layer base { select:not([multiple]):not([size]) { … } }'
    ).not.toBeNull();
    // Safari ignores min-height on a native pop-up button; without this the
    // min-height below does nothing there.
    expect(rule![1]).toMatch(/(^|;)\s*appearance:\s*none\s*;/);
    expect(rule![1]).toMatch(/-webkit-appearance:\s*none\s*;/);
  });

  it('and is at least 24px tall, with room kept for its chevron', () => {
    const minHeight = /min-height:\s*([\d.]+)(rem|px)/.exec(rule![1]);
    expect(minHeight).not.toBeNull();
    const px = minHeight![2] === 'rem' ? Number(minHeight![1]) * 16 : Number(minHeight![1]);
    expect(px).toBeGreaterThanOrEqual(24);
    expect(rule![1]).toMatch(/background-image:\s*url\(/);
    expect(rule![1]).toMatch(/padding-inline-end:[^;]*!important/);
  });
});
