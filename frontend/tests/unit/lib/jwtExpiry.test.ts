import { describe, expect, it } from 'vitest';
import { EXPIRY_SKEW_SECONDS, jwtExpiresAt, jwtIsExpired } from '@/lib/jwtExpiry';

/** An unsigned JWT-shaped token whose payload is `claims`. */
function tokenWith(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

describe('jwtExpiresAt', () => {
  it('reads exp (seconds) as a millisecond timestamp', () => {
    expect(jwtExpiresAt(tokenWith({ exp: 1_700_000_000, sub: 'u1' }))).toBe(1_700_000_000_000);
  });

  it('is null for anything that is not a readable JWT', () => {
    expect(jwtExpiresAt('access-1')).toBeNull();
    expect(jwtExpiresAt('')).toBeNull();
    expect(jwtExpiresAt('a.b')).toBeNull();
    expect(jwtExpiresAt('a.%%%.c')).toBeNull();
    expect(jwtExpiresAt(tokenWith({ sub: 'u1' }))).toBeNull();
    expect(jwtExpiresAt(tokenWith({ exp: 'soon' }))).toBeNull();
  });

  it('handles base64url payloads that need padding', () => {
    // Payload lengths that are not a multiple of four are the common case;
    // every one of these must decode.
    for (const exp of [1, 12, 123, 1234, 12345, 123456]) {
      expect(jwtExpiresAt(tokenWith({ exp }))).toBe(exp * 1000);
    }
  });
});

describe('jwtIsExpired', () => {
  const now = 1_700_000_000_000;

  it('is true once exp has passed', () => {
    expect(jwtIsExpired(tokenWith({ exp: 1_700_000_000 - 1 }), now)).toBe(true);
  });

  it('is true inside the skew window, so a request never lands a second too late', () => {
    const exp = 1_700_000_000 + EXPIRY_SKEW_SECONDS - 1;
    expect(jwtIsExpired(tokenWith({ exp }), now)).toBe(true);
  });

  it('is false while the token is still good beyond the skew', () => {
    const exp = 1_700_000_000 + EXPIRY_SKEW_SECONDS + 1;
    expect(jwtIsExpired(tokenWith({ exp }), now)).toBe(false);
  });

  it('is false for a token it cannot read: the server keeps the last word', () => {
    expect(jwtIsExpired('access-1', now)).toBe(false);
    expect(jwtIsExpired(tokenWith({ sub: 'u1' }), now)).toBe(false);
  });
});
