/**
 * utils/credentialPath.ts — the request path as a log line may carry it (#450).
 *
 * A capability URL's path IS its credential, so what these tests pin is not a
 * string format but a promise: after redaction the secret is not in the string,
 * and nothing else about the path moved.
 */
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PATH_PARAMS, redactCredentialPath } from '../../../src/utils/credentialPath.js';

const TOKEN = 'a1b2c3d4'.repeat(8);
const CODE = 'f0e1d2c3'.repeat(4);

describe('redactCredentialPath', () => {
  it('replaces a {token} segment, wherever it sits in the path', () => {
    expect(redactCredentialPath(`/sitter/${TOKEN}`, { token: TOKEN })).toBe('/sitter/{token}');
    expect(
      redactCredentialPath(`/tag/${TOKEN}/tasks/t-9/complete`, { token: TOKEN, taskId: 't-9' })
    ).toBe('/tag/{token}/tasks/t-9/complete');
    expect(redactCredentialPath(`/calendar/${TOKEN}/family-greenhouse.ics`, { token: TOKEN })).toBe(
      '/calendar/{token}/family-greenhouse.ics'
    );
  });

  it('replaces a share {code} too — the parameter is not called token', () => {
    expect(redactCredentialPath(`/plants/shared/${CODE}/accept`, { code: CODE })).toBe(
      '/plants/shared/{code}/accept'
    );
  });

  it('replaces the percent-encoded spelling as well as the raw one', () => {
    const odd = 'ab cd+ef/gh'.repeat(2);
    expect(redactCredentialPath(`/x/${encodeURIComponent(odd)}`, { token: odd })).toBe(
      '/x/{token}'
    );
  });

  it('leaves every other path, and every other parameter, exactly as it was', () => {
    expect(redactCredentialPath('/plants', null)).toBe('/plants');
    expect(redactCredentialPath('/plants/p-1234567890/tag', { plantId: 'p-1234567890' })).toBe(
      '/plants/p-1234567890/tag'
    );
    expect(redactCredentialPath('/plants', undefined)).toBe('/plants');
  });

  it('never rewrites a path over a value too short to be a credential', () => {
    expect(redactCredentialPath('/plants/1/tasks/1', { token: '1' })).toBe('/plants/1/tasks/1');
  });

  it('removes every occurrence, not just the first', () => {
    expect(redactCredentialPath(`/a/${TOKEN}/b/${TOKEN}`, { token: TOKEN })).toBe(
      '/a/{token}/b/{token}'
    );
  });

  it('names the credential parameters once, and a new route’s parameter has to be added there', () => {
    // If a route starts carrying a credential under a third name, this list is
    // where it goes — and credential-leaks.test.ts drives every such route.
    expect([...CREDENTIAL_PATH_PARAMS]).toEqual(['token', 'code']);
  });
});
