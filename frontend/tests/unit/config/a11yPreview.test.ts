import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  A11Y_PREVIEW_STORAGE_KEY,
  SELECTED_STATE_STYLES,
  readA11yPreview,
} from '@/config/a11yPreview';

const storage = (value: string | null) => ({ getItem: () => value });

describe('a11y preview flag', () => {
  it('is off unless set, so a production visitor sees no change', () => {
    expect(readA11yPreview({ DEV: false }, storage(null))).toBeNull();
    expect(readA11yPreview({ DEV: true }, storage(null))).toBeNull();
  });

  it('takes a known style from the build', () => {
    expect(readA11yPreview({ DEV: false, VITE_A11Y_PREVIEW: 'fill' }, null)).toBe('fill');
    expect(readA11yPreview({ DEV: false, VITE_A11Y_PREVIEW: 'bold' }, null)).toBeNull();
  });

  it('reads localStorage only in the dev server', () => {
    expect(readA11yPreview({ DEV: true }, storage('check'))).toBe('check');
    expect(readA11yPreview({ DEV: false }, storage('check'))).toBeNull();
    expect(readA11yPreview({ DEV: true }, storage('nonsense'))).toBeNull();
  });

  it('survives storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readA11yPreview({ DEV: true, VITE_A11Y_PREVIEW: 'edge' }, throwing)).toBe('edge');
  });

  it('uses one storage key', () => {
    expect(A11Y_PREVIEW_STORAGE_KEY).toBe('fg.a11yPreview');
  });
});

describe('selected-state styles in index.css', () => {
  const css = readFileSync(resolve(__dirname, '../../../src/index.css'), 'utf8');

  it.each(SELECTED_STATE_STYLES)('%s has a rule, and only under its data attribute', (style) => {
    expect(css).toContain(`[data-selected-style='${style}']`);
  });

  it('adds no words: the check mark is empty generated content', () => {
    const before = /\.fg-sel-chip\[aria-pressed='true'\]::before[\s\S]*?{([^}]*)}/.exec(css);
    expect(before).not.toBeNull();
    expect(before![1]).toMatch(/content:\s*''/);
  });
});
