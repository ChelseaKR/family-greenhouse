import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/outageTrialRestart.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/outageTrialRestart.js')>();
  return {
    RESTART_ID: actual.RESTART_ID,
    REFUSAL_TEXT: actual.REFUSAL_TEXT,
    planOutageTrialRestart: vi.fn(),
    restartOutageTrial: vi.fn(),
  };
});
vi.mock('../../../src/utils/dynamodb.js', () => ({ dynamodb: { send: vi.fn() }, TABLE_NAME: 't' }));
vi.mock('../../../src/utils/cognito.js', () => ({ cognito: { send: vi.fn() }, USER_POOL_ID: 'p' }));

import * as service from '../../../src/services/outageTrialRestart.js';
import { parseCliArgs, run, type RunDeps } from '../../../src/scripts/restartOutageTrial.js';
import type { RestartPlan } from '../../../src/services/outageTrialRestart.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const HOUSEHOLD_ID = '3f2a9c1e-household-id';

const PLAN: RestartPlan = {
  ok: true,
  oldTrial: { startedAt: '2026-10-21T17:00:00.000Z', endedAt: '2026-11-04T17:00:00.000Z' },
  startedAt: '2026-11-21T12:00:00.000Z',
  endsAt: '2026-12-05T12:00:00.000Z',
  day10From: '2026-12-01T12:00:00.000Z',
  day14Until: '2026-12-08T12:00:00.000Z',
  trialEmailMarkers: 0,
  admins: 1,
  adminsReachable: 1,
  sub: { planId: 'seedling', noCardTrialEndsAt: '2026-11-04T17:00:00.000Z' },
};

let lines: string[];
const deps = (): RunDeps => ({ now: NOW, print: (line) => lines.push(line) });

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  vi.mocked(service.planOutageTrialRestart).mockResolvedValue(PLAN);
  vi.mocked(service.restartOutageTrial).mockResolvedValue({
    status: 'restarted',
    startedAt: PLAN.startedAt,
    endsAt: PLAN.endsAt,
  });
});

describe('parseCliArgs', () => {
  it('takes one household id, dry run by default', () => {
    expect(parseCliArgs([HOUSEHOLD_ID])).toEqual({ householdId: HOUSEHOLD_ID, confirm: false });
    expect(parseCliArgs([HOUSEHOLD_ID, '--confirm'])).toEqual({
      householdId: HOUSEHOLD_ID,
      confirm: true,
    });
  });

  it.each([[[]], [['a', 'b']], [['--confirm']], [['  ']]])('refuses %j', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow('Pass exactly one household id.');
  });
});

describe('run', () => {
  it('dry run writes nothing and prints dates and counts only', async () => {
    expect(await run([HOUSEHOLD_ID], deps())).toBe(0);
    expect(service.planOutageTrialRestart).toHaveBeenCalledWith(HOUSEHOLD_ID, NOW);
    expect(service.restartOutageTrial).not.toHaveBeenCalled();
    expect(lines).toEqual([
      'No-card trial restart (trial-restart-2026-11): dry run',
      'Old trial: 2026-10-21T17:00:00.000Z to 2026-11-04T17:00:00.000Z, ended during the outage.',
      'New trial: starts 2026-11-21T12:00:00.000Z, ends 2026-12-05T12:00:00.000Z (the two trial dates written).',
      'Trial emails: day 10 due from 2026-12-01T12:00:00.000Z, day 14 from 2026-12-05T12:00:00.000Z until 2026-12-08T12:00:00.000Z; 0 earlier trial-email markers.',
      'Admins: 1, 1 with email and trial notices on.',
      'Dry run only: nothing was written. Pass --confirm to start the trial.',
    ]);
    expect(lines.join('\n')).not.toContain(HOUSEHOLD_ID);
    expect(lines.join('\n')).not.toContain('@');
  });

  it('--confirm writes the planned dates', async () => {
    expect(await run([HOUSEHOLD_ID, '--confirm'], deps())).toBe(0);
    expect(service.restartOutageTrial).toHaveBeenCalledWith(HOUSEHOLD_ID, PLAN, NOW);
    expect(lines[0]).toBe('No-card trial restart (trial-restart-2026-11): WRITING');
    expect(lines.at(-1)).toBe(
      'Restarted: the trial runs from 2026-11-21T12:00:00.000Z to 2026-12-05T12:00:00.000Z.'
    );
  });

  it.each([
    'no_household',
    'no_trial',
    'trial_active',
    'paid_stripe',
    'paid_app_store',
    'paid_gift',
    'unreadable_end',
    'outside_window',
    'already_restarted',
  ] as const)('a %s refusal exits 1 and writes nothing, even with --confirm', async (reason) => {
    vi.mocked(service.planOutageTrialRestart).mockResolvedValue({ ok: false, reason });
    expect(await run([HOUSEHOLD_ID, '--confirm'], deps())).toBe(1);
    expect(service.restartOutageTrial).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe(`Refused: ${service.REFUSAL_TEXT[reason]} Nothing was written.`);
  });

  it('a row that changed after the read exits 1', async () => {
    vi.mocked(service.restartOutageTrial).mockResolvedValue({ status: 'changed' });
    expect(await run([HOUSEHOLD_ID, '--confirm'], deps())).toBe(1);
    expect(lines.at(-1)).toContain('changed after it was read');
  });

  it('a marker written between the read and the write exits 1', async () => {
    vi.mocked(service.restartOutageTrial).mockResolvedValue({ status: 'already_restarted' });
    expect(await run([HOUSEHOLD_ID, '--confirm'], deps())).toBe(1);
    expect(lines.at(-1)).toContain('already restarted once');
  });

  it('bad arguments exit 1 before any read', async () => {
    expect(await run([], deps())).toBe(1);
    expect(service.planOutageTrialRestart).not.toHaveBeenCalled();
  });
});
