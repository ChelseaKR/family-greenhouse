import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/emailOutageNotice.js', () => ({
  NOTICE_ID: 'email-outage-2026-11',
  SEND_CUTOFF: '2026-11-23T00:00:00.000Z',
  planEmailOutageNotice: vi.fn(),
  previewSuppression: vi.fn(),
  sendEmailOutageNotice: vi.fn(),
}));

import * as notice from '../../../src/services/emailOutageNotice.js';
import {
  cutoffRefusal,
  parseAllowlist,
  parseCliArgs,
  run,
  sendEnvironmentProblem,
  type RunDeps,
} from '../../../src/scripts/sendEmailOutageNotice.js';

const BEFORE = new Date('2026-11-21T12:00:00.000Z');
const AT_CUTOFF = new Date('2026-11-23T00:00:00.000Z');
const SEND_ENV = {
  SES_FROM_EMAIL: 'Family Greenhouse <hello@familygreenhouse.net>',
  FRONTEND_URL: 'https://familygreenhouse.net',
};

const recipient = (userId: string, trial: boolean) => ({
  userId,
  email: `${userId}@example.com`,
  name: 'Sam',
  timeZone: 'UTC',
  trial: trial ? { startedAt: 'a', endedAt: 'b' } : null,
});

let lines: string[];
function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    now: BEFORE,
    env: SEND_ENV,
    print: (line) => lines.push(line),
    readFile: () => '',
    ...overrides,
  };
}

beforeEach(() => {
  lines = [];
  vi.mocked(notice.planEmailOutageNotice).mockResolvedValue({
    householdsScanned: 5,
    householdsExcludedAsTest: 2,
    householdsNotAllowlisted: 0,
    householdsWithEndedTrial: 1,
    recipients: [recipient('u1', true), recipient('u2', false)],
    skipped: { emailOff: 1, noAddress: 0, alreadySent: 0 },
  });
  vi.mocked(notice.previewSuppression).mockImplementation(async (recipients) => ({
    sendable: [...recipients],
    suppressed: 0,
    suppressionUnknown: 0,
  }));
  vi.mocked(notice.sendEmailOutageNotice).mockResolvedValue({
    sent: 2,
    sentWithTrialParagraph: 1,
    alreadySent: 0,
    suppressed: 0,
    suppressionUnknown: 0,
    notConfigured: 0,
    failed: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('parseCliArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseCliArgs([])).toEqual({ confirm: false, late: false, allowlist: null });
  });
  it('reads --confirm, --late and --allowlist', () => {
    expect(parseCliArgs(['--confirm', '--late', '--allowlist', 'ids.txt'])).toEqual({
      confirm: true,
      late: true,
      allowlist: 'ids.txt',
    });
  });
  it('rejects an unknown flag', () => {
    expect(() => parseCliArgs(['--yes'])).toThrow();
  });
});

describe('cutoffRefusal', () => {
  it('allows a run before 2026-11-23 00:00 UTC', () => {
    expect(cutoffRefusal(new Date('2026-11-22T23:59:59.999Z'), false)).toBeNull();
  });
  it('refuses at and after the cutoff unless --late', () => {
    expect(cutoffRefusal(AT_CUTOFF, false)).toMatch(/--late/);
    expect(cutoffRefusal(new Date('2026-12-01T00:00:00Z'), false)).toMatch(/--late/);
    expect(cutoffRefusal(AT_CUTOFF, true)).toBeNull();
  });
});

describe('sendEnvironmentProblem', () => {
  it('needs SES_FROM_EMAIL and an https FRONTEND_URL', () => {
    expect(sendEnvironmentProblem(SEND_ENV)).toBeNull();
    expect(sendEnvironmentProblem({ FRONTEND_URL: SEND_ENV.FRONTEND_URL })).toMatch(
      /SES_FROM_EMAIL/
    );
    expect(sendEnvironmentProblem({ SES_FROM_EMAIL: 'x' })).toMatch(/FRONTEND_URL/);
    expect(
      sendEnvironmentProblem({ SES_FROM_EMAIL: 'x', FRONTEND_URL: 'http://localhost:3000' })
    ).toMatch(/FRONTEND_URL/);
  });
});

describe('parseAllowlist', () => {
  it('reads one id per line, ignoring comments and blanks', () => {
    expect([...parseAllowlist('h1\n# test ones left out\n\n h2 # mine\r\n')]).toEqual(['h1', 'h2']);
  });
});

describe('run', () => {
  it('a dry run sends nothing and prints counts only', async () => {
    const code = await run([], deps());
    expect(code).toBe(0);
    expect(notice.sendEmailOutageNotice).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('2 would be emailed, 1 of them with the trial paragraph');
    expect(lines.join('\n')).toContain('nothing was emailed and nothing was written');
    expect(lines.join('\n')).not.toMatch(/@|u1|u2|Sam/);
  });

  it('a dry run still works without send settings, and says --confirm would refuse', async () => {
    const code = await run([], deps({ env: {} }));
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/--confirm would refuse.*SES_FROM_EMAIL/);
  });

  it('--confirm sends and reports counts', async () => {
    const code = await run(['--confirm'], deps());
    expect(code).toBe(0);
    expect(notice.sendEmailOutageNotice).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('Sent: 2, 1 of them with the trial paragraph.');
    expect(lines.join('\n')).not.toMatch(/@|u1|u2|Sam/);
  });

  it('--confirm refuses without send settings, before reading anything', async () => {
    const code = await run(['--confirm'], deps({ env: {} }));
    expect(code).toBe(1);
    expect(notice.planEmailOutageNotice).not.toHaveBeenCalled();
    expect(notice.sendEmailOutageNotice).not.toHaveBeenCalled();
  });

  it('refuses after the cutoff, before reading anything, unless --late', async () => {
    expect(await run(['--confirm'], deps({ now: AT_CUTOFF }))).toBe(1);
    expect(await run([], deps({ now: AT_CUTOFF }))).toBe(1);
    expect(notice.planEmailOutageNotice).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/--late/);

    expect(await run(['--confirm', '--late'], deps({ now: AT_CUTOFF }))).toBe(0);
    expect(notice.sendEmailOutageNotice).toHaveBeenCalledTimes(1);
  });

  it('passes an allowlist file through to the plan', async () => {
    await run(['--allowlist', 'ids.txt'], deps({ readFile: () => 'h1\nh2\n' }));
    expect(vi.mocked(notice.planEmailOutageNotice).mock.calls[0]?.[0].allowlist).toEqual(
      new Set(['h1', 'h2'])
    );
  });

  it('exits non-zero when some sends failed', async () => {
    vi.mocked(notice.sendEmailOutageNotice).mockResolvedValueOnce({
      sent: 1,
      sentWithTrialParagraph: 0,
      alreadySent: 0,
      suppressed: 0,
      suppressionUnknown: 0,
      notConfigured: 0,
      failed: 1,
    });
    expect(await run(['--confirm'], deps())).toBe(1);
    expect(lines.join('\n')).toMatch(/re-running sends only to them/);
  });
});
