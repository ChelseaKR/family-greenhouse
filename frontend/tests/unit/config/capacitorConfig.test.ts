import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../../capacitor.config';

describe('Capacitor native networking', () => {
  it('keeps the native HTTP bridge enabled for API and presigned image requests', () => {
    expect(config.plugins?.CapacitorHttp).toEqual({ enabled: true });
  });

  it('fails store validation if browser-only chat streaming is accidentally enabled', () => {
    const validator = readFileSync(
      resolve(process.cwd(), '../scripts/validate-store-release.mjs'),
      'utf8'
    );
    expect(validator).toMatch(
      /if \(process\.env\.VITE_CHAT_STREAM_URL\) \{\s*fail\('VITE_CHAT_STREAM_URL must be unset for native store builds'\)/
    );
  });
});
