import { describe, expect, it } from 'vitest';
import { safeAppRedirect } from '@/features/auth/safeRedirect';

describe('safeAppRedirect', () => {
  it.each([
    ['/join/code-1', '/join/code-1'],
    ['/shared/cutting-1?from=invite#details', '/shared/cutting-1?from=invite#details'],
    ['/plants/../dashboard', '/dashboard'],
  ])('accepts and canonicalizes a same-origin app path: %s', (value, expected) => {
    expect(safeAppRedirect(value)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    '',
    'https://evil.example/path',
    '//evil.example/path',
    '/\\evil.example/path',
    '/%5Cevil.example/path',
    '/%255Cevil.example/path',
    '/%2F%2Fevil.example/path',
    '/%252F%252Fevil.example/path',
    '/%2e%2e//evil.example/path',
    '/%E0%A4%A',
  ])('rejects an unsafe or malformed redirect: %s', (value) => {
    expect(safeAppRedirect(value)).toBeNull();
  });
});
