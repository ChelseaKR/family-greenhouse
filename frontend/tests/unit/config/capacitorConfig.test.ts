import { describe, expect, it } from 'vitest';
import config from '../../../capacitor.config';

describe('Capacitor native networking', () => {
  it('keeps the native HTTP bridge enabled for API and presigned image requests', () => {
    expect(config.plugins?.CapacitorHttp).toEqual({ enabled: true });
  });
});
