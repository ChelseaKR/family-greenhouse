/**
 * The unsubscribe flow over the real dev server.
 *
 * Two things are worth testing here rather than at the unit boundary:
 *
 *   1. **A GET must never unsubscribe anyone.** Outlook Safe Links, corporate
 *      scanning proxies and mail-client prefetchers fetch every URL in a
 *      message. If the GET mutated, everyone whose employer scans mail would
 *      be silently unsubscribed from a link they never clicked. The unit test
 *      asserts the handler does not call the write; this asserts the
 *      preference genuinely still reads as on afterwards.
 *
 *   2. **Both routes are throttled per IP.** They are unauthenticated and both
 *      make an authorization decision (`verifyTokenWithSecret`), which is what
 *      CodeQL's js/missing-rate-limiting flags. The dev mirror carries the
 *      same limits as production (GET 30/min for prefetchers, POST 10/min) so
 *      what you exercise locally is what ships.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { app, __resetUnsubscribeRateLimitForTests } from '../../src/local-server.js';

const TOKEN_PATH = '/notifications/email/unsubscribe';

/** Mint a dev-server token through the DEV-ONLY helper route. */
async function mintToken(category = 'weekly_digest'): Promise<string> {
  const res = await request(app)
    .get(`/notifications/email/dev-token?category=${category}`)
    .set('Authorization', 'Bearer mock-token-550e8400-e29b-41d4-a716-446655440000-1');
  expect(res.status).toBe(200);
  return res.body.token as string;
}

async function readPrefs() {
  const res = await request(app)
    .get('/notifications/prefs')
    .set('Authorization', 'Bearer mock-token-550e8400-e29b-41d4-a716-446655440000-1');
  expect(res.status).toBe(200);
  return res.body as { weeklyDigest: boolean; yearRecap: boolean; email: boolean };
}

describe('email unsubscribe over the dev server', () => {
  let token: string;

  beforeEach(async () => {
    // The dev server's prefs store and limiter buckets are module-level, so
    // each case starts from a known state rather than inheriting the last.
    __resetUnsubscribeRateLimitForTests();
    await request(app)
      .put('/notifications/prefs')
      .set('Authorization', 'Bearer mock-token-550e8400-e29b-41d4-a716-446655440000-1')
      .send({
        browser: false,
        email: true,
        sms: false,
        phone: '',
        dndStart: '',
        dndEnd: '',
        timezone: 'UTC',
        pestAlerts: false,
        weeklyDigest: true,
        yearRecap: true,
      });
    token = await mintToken();
  });

  it('GET renders a confirm form and changes NOTHING', async () => {
    const before = await readPrefs();
    expect(before.weeklyDigest).toBe(true);

    const res = await request(app).get(`${TOKEN_PATH}?t=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('<form method="post"');

    // The prefetcher case: the preference is untouched.
    expect((await readPrefs()).weeklyDigest).toBe(true);
  });

  it('POST performs the unsubscribe and is idempotent', async () => {
    const first = await request(app).post(`${TOKEN_PATH}?t=${encodeURIComponent(token)}`);
    expect(first.status).toBe(200);
    expect((await readPrefs()).weeklyDigest).toBe(false);

    // A provider may retry the one-click POST.
    const second = await request(app).post(`${TOKEN_PATH}?t=${encodeURIComponent(token)}`);
    expect(second.status).toBe(200);
    expect((await readPrefs()).weeklyDigest).toBe(false);
  });

  it('turns off only the token’s own category', async () => {
    await request(app).post(`${TOKEN_PATH}?t=${encodeURIComponent(token)}`);
    const prefs = await readPrefs();
    expect(prefs.weeklyDigest).toBe(false);
    // The annual recap and the master email switch are untouched.
    expect(prefs.yearRecap).toBe(true);
    expect(prefs.email).toBe(true);
  });

  it('410s a token whose signature does not verify', async () => {
    const tampered = `${token.slice(0, -4)}AAAA`;
    const res = await request(app).post(`${TOKEN_PATH}?t=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(410);
    expect((await readPrefs()).weeklyDigest).toBe(true);
  });

  it('400s a request with no token at all', async () => {
    expect((await request(app).get(TOKEN_PATH)).status).toBe(400);
    expect((await request(app).post(TOKEN_PATH)).status).toBe(400);
  });

  it('throttles the GET, and the limit is generous enough for a prefetcher', async () => {
    const url = `${TOKEN_PATH}?t=${encodeURIComponent(token)}`;
    let throttledAt = -1;
    for (let i = 0; i < 40; i++) {
      const res = await request(app).get(url);
      if (res.status === 429) {
        throttledAt = i;
        break;
      }
    }
    // A limiter exists (CodeQL js/missing-rate-limiting), and it does not trip
    // so early that a scanning proxy would lock out the human behind it.
    expect(throttledAt).toBeGreaterThanOrEqual(20);
    expect(throttledAt).toBeLessThan(40);

    // And the prefetch flood must NOT have spent the POST's budget — that is
    // the lockout this keying exists to prevent.
    expect((await request(app).post(url)).status).toBe(200);
  });

  it('throttles the POST more tightly, since it is the one that writes', async () => {
    const url = `${TOKEN_PATH}?t=${encodeURIComponent(token)}`;
    let throttledAt = -1;
    for (let i = 0; i < 30; i++) {
      const res = await request(app).post(url);
      if (res.status === 429) {
        throttledAt = i;
        break;
      }
    }
    expect(throttledAt).toBeGreaterThan(0);
    expect(throttledAt).toBeLessThanOrEqual(20);
  });
});
