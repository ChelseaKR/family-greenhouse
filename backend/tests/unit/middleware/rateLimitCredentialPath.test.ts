/**
 * The rate limiter's bucket key is written to the audit log when a limit trips
 * (`rate_limit.tripped`). On an event with no route template it falls back to
 * the literal path — and a capability URL's path is its credential (#450).
 * Production events carry a `routeKey`, so this is a defect that only bites on
 * an event shape without one; the fallback still has to be safe, because the
 * bucket key would otherwise be a plaintext token in a 30-day log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

vi.mock('../../../src/utils/auditLog.js', () => ({ audit: vi.fn() }));

import { audit } from '../../../src/utils/auditLog.js';
import { __resetRateLimitForTests, rateLimit } from '../../../src/middleware/rateLimit.js';

const TOKEN = 'c0ffee00'.repeat(8);

function scanEvent(extra: Record<string, unknown> = {}): APIGatewayProxyEvent {
  return {
    rawPath: `/tag/${TOKEN}`,
    pathParameters: { token: TOKEN },
    requestContext: { http: { method: 'GET', sourceIp: '9.9.9.9' } },
    headers: {},
    ...extra,
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  __resetRateLimitForTests();
  vi.mocked(audit).mockClear();
});

describe('rateLimit bucket key on an event with no route template', () => {
  it('does not put the credential in the key it audits when the limit trips', () => {
    const before = rateLimit({ perWindowMs: 60_000, max: 1 }).before!;
    const request = (e: APIGatewayProxyEvent) => ({ event: e }) as never;
    before(request(scanEvent()));
    expect(() => before(request(scanEvent()))).toThrow(/Too many requests/);

    const [, detail] = vi.mocked(audit).mock.calls[0] as [string, { metadata: { key: string } }];
    expect(detail.metadata.key).toBe('/tag/{token}|9.9.9.9');
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(TOKEN);
  });

  it('still buckets one credential and another together, so varying it cannot dodge the cap', () => {
    const before = rateLimit({ perWindowMs: 60_000, max: 1 }).before!;
    const other = 'deadbeef'.repeat(8);
    const request = (e: APIGatewayProxyEvent) => ({ event: e }) as never;
    before(request(scanEvent()));
    expect(() =>
      before(request(scanEvent({ rawPath: `/tag/${other}`, pathParameters: { token: other } })))
    ).toThrow(/Too many requests/);
  });
});
