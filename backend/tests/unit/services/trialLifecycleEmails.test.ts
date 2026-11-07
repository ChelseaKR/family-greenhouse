/**
 * The trial lifecycle emails (ADR 0039), end to end through the REAL
 * `emailNotifier` (so suppression is the production code path) with SES and
 * the suppression store mocked at their edges.
 *
 * Every "sends nothing" test has a positive control: the same fixture, with
 * only the guard lifted, does send. And every sabotage is asserted to have
 * been applied (the guarded dependency was actually consulted), so a sabotage
 * that silently does nothing cannot read as a pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sesSendMock = vi.fn();
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn(function () {
    return { send: sesSendMock };
  }),
  SendRawEmailCommand: vi.fn(function (input) {
    return { input, kind: 'SendRawEmail' };
  }),
}));
const checkAddressMock = vi.fn();
vi.mock('../../../src/services/emailSuppression.js', () => ({
  checkAddress: (...args: unknown[]) => checkAddressMock(...args),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  listAllHouseholdIds: vi.fn(),
  getHouseholdMembers: vi.fn(),
}));
vi.mock('../../../src/services/email/capability.js', () => ({
  mintUnsubscribeToken: vi.fn(),
}));
vi.mock('../../../src/services/trialLifecycleFacts.js', () => ({
  readTrialFacts: vi.fn(),
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as householdService from '../../../src/services/householdService.js';
import * as capability from '../../../src/services/email/capability.js';
import * as factsModule from '../../../src/services/trialLifecycleFacts.js';
import {
  runTrialLifecycleEmails,
  trialEmailDue,
} from '../../../src/services/trialLifecycleEmails.js';

interface FakeCommand {
  kind: 'Put' | 'Get' | 'Delete' | 'Update' | 'Query';
  input: {
    Key?: { PK?: string; SK?: string };
    Item?: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
}

let rows: Map<string, Record<string, unknown>>;

const keyOf = (cmd: FakeCommand): string => {
  const key = cmd.input.Key ?? {
    PK: cmd.input.Item?.PK as string,
    SK: cmd.input.Item?.SK as string,
  };
  return `${key.PK}|${key.SK}`;
};

function conditionalFailure(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

function conditionHolds(
  cond: string | undefined,
  values: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
): boolean {
  if (!cond) return true;
  if (cond.startsWith('attribute_not_exists(PK)')) {
    if (!existing) return true;
    return (
      existing.status === values[':sending'] &&
      (existing.leaseExpiresAt as number) <= (values[':now'] as number)
    );
  }
  if (cond.includes('#status = :sending AND reservationId')) {
    return (
      !!existing &&
      existing.status === values[':sending'] &&
      existing.reservationId === values[':reservationId']
    );
  }
  if (cond === 'reservationId = :reservationId') {
    return !!existing && existing.reservationId === values[':reservationId'];
  }
  return true;
}

function installFakeTable(): void {
  vi.mocked(dynamodb.send).mockImplementation((command: unknown) => {
    const cmd = command as FakeCommand;
    if (cmd.kind === 'Query') return Promise.resolve({ Items: [], Count: 0 }) as never;
    const key = keyOf(cmd);
    const existing = rows.get(key);
    if (cmd.kind === 'Get') return Promise.resolve({ Item: existing }) as never;
    if (
      !conditionHolds(
        cmd.input.ConditionExpression,
        cmd.input.ExpressionAttributeValues ?? {},
        existing
      )
    ) {
      return Promise.reject(conditionalFailure()) as never;
    }
    if (cmd.kind === 'Put') rows.set(key, cmd.input.Item ?? {});
    else if (cmd.kind === 'Update') {
      rows.set(key, {
        ...existing,
        status: 'sent',
        leaseExpiresAt: undefined,
        reservationId: undefined,
      });
    } else if (cmd.kind === 'Delete') rows.delete(key);
    return Promise.resolve({}) as never;
  });
}

const ENABLED = { TRIAL_LIFECYCLE_EMAILS_ENABLED: 'true' } as NodeJS.ProcessEnv;
const DISABLED = {} as NodeJS.ProcessEnv;

const STARTED = '2026-10-01T10:00:00.000Z';
const ENDS = '2026-10-15T10:00:00.000Z';
const DAY10 = new Date('2026-10-11T17:30:00.000Z'); // 3.6 days left
const DAY14 = new Date('2026-10-16T17:30:00.000Z'); // ended 1.3 days ago
const TOO_EARLY = new Date('2026-10-05T17:30:00.000Z'); // 9.6 days left
const TOO_LATE = new Date('2026-10-30T17:30:00.000Z'); // ended 15 days ago

const ADMIN = {
  householdId: 'hh-1',
  userId: 'user-admin',
  name: 'Sam',
  email: 'admin@example.com',
  role: 'admin' as const,
  joinedAt: '2026-10-01T00:00:00.000Z',
};
const MEMBER = {
  ...ADMIN,
  userId: 'user-member',
  email: 'member@example.com',
  role: 'member' as const,
};

function seedHousehold(extra: Record<string, unknown> = {}): void {
  rows.set('HOUSEHOLD#hh-1|METADATA', {
    planId: 'seedling',
    noCardTrialStartedAt: STARTED,
    noCardTrialEndsAt: ENDS,
    ...extra,
  });
}

function seedPrefs(userId: string, extra: Record<string, unknown> = {}): void {
  rows.set(`USER#${userId}|PREFS`, {
    userId,
    email: true,
    trialNotices: true,
    timezone: 'UTC',
    ...extra,
  });
}

function markerKeys(): string[] {
  return [...rows.keys()].filter((k) => k.includes('TRIAL_EMAIL#'));
}

function sentRaw(): string {
  const cmd = sesSendMock.mock.calls[0][0] as { input: { RawMessage: { Data: Buffer } } };
  return cmd.input.RawMessage.Data.toString('utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
  process.env.SES_FROM_EMAIL = 'hello@familygreenhouse.net';
  process.env.SES_REPLY_TO = 'support@familygreenhouse.net';
  process.env.FRONTEND_URL = 'https://familygreenhouse.net';
  process.env.PUBLIC_API_URL = 'https://api.familygreenhouse.net';
  installFakeTable();
  sesSendMock.mockResolvedValue({ MessageId: 'm-1' });
  checkAddressMock.mockResolvedValue({ status: 'sendable' });
  vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh-1']);
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([ADMIN]);
  vi.mocked(capability.mintUnsubscribeToken).mockResolvedValue({ status: 'ok', token: 'tok-1' });
  vi.mocked(factsModule.readTrialFacts).mockResolvedValue({
    plantsAdded: { status: 'ok', value: 6 },
    tasksCompleted: { status: 'ok', value: 11 },
    plantsNow: { status: 'ok', value: 6 },
    membersNow: { status: 'ok', value: 2 },
  });
  seedHousehold();
  seedPrefs('user-admin');
});

describe('which email is due (pure)', () => {
  const sub = { noCardTrialEndsAt: ENDS, planId: 'seedling' };
  it('day 10 inside the last 4 days, day 14 within 3 days after, nothing otherwise', () => {
    expect(trialEmailDue(sub, TOO_EARLY)).toBeNull();
    expect(trialEmailDue(sub, DAY10)?.kind).toBe('trial_day10');
    expect(trialEmailDue(sub, DAY14)?.kind).toBe('trial_day14');
    expect(trialEmailDue(sub, TOO_LATE)).toBeNull();
    expect(trialEmailDue(sub, DAY10)?.startedAt).toBe(STARTED);
  });
  it('nothing for a household with Stripe state, a running gift, or no trial', () => {
    expect(
      trialEmailDue({ ...sub, status: 'trialing', stripeSubscriptionId: 'sub_1' }, DAY10)
    ).toBeNull();
    expect(trialEmailDue({ ...sub, planId: 'garden' }, DAY14)).toBeNull();
    expect(trialEmailDue({ planId: 'seedling' }, DAY10)).toBeNull();
    expect(trialEmailDue({ ...sub, noCardTrialEndsAt: 'not a date' }, DAY10)).toBeNull();
    expect(
      trialEmailDue({ ...sub, giftPlanId: 'garden', giftEndsAt: '2026-12-01T00:00:00.000Z' }, DAY10)
    ).toBeNull();
  });
});

describe('the flag', () => {
  it('OFF: reads nothing, writes nothing, sends nothing, and the same fixture sends once ON', async () => {
    const off = await runTrialLifecycleEmails(DAY10, {}, DISABLED);
    expect(off.enabled).toBe(false);
    expect(sesSendMock).not.toHaveBeenCalled();
    expect(householdService.listAllHouseholdIds).not.toHaveBeenCalled();
    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(markerKeys()).toEqual([]);

    // Positive control: only the flag changes.
    const on = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(on.enabled).toBe(true);
    expect(on.sent).toBe(1);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
  });

  it.each(['1', 'TRUE', ' true', 'yes', 'false', ''])('is off for the value %j', async (value) => {
    const summary = await runTrialLifecycleEmails(DAY10, {}, {
      TRIAL_LIFECYCLE_EMAILS_ENABLED: value,
    } as NodeJS.ProcessEnv);
    expect(summary.enabled).toBe(false);
    expect(sesSendMock).not.toHaveBeenCalled();
  });
});

describe('suppression, consent and quiet hours', () => {
  it('a suppressed address gets nothing, the slot is released, and it is delivered once resumed', async () => {
    checkAddressMock.mockResolvedValue({
      status: 'suppressed',
      state: { reason: 'hard_bounce' },
    });
    const blocked = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    // The sabotage applied: the real notifier consulted the suppression list
    // for this very address, and refused.
    expect(checkAddressMock).toHaveBeenCalledWith('admin@example.com');
    expect(sesSendMock).not.toHaveBeenCalled();
    expect(blocked.notDelivered).toBe(1);
    expect(blocked.sent).toBe(0);
    expect(markerKeys()).toEqual([]);

    // Positive control: the address is resumed; the same email now goes.
    checkAddressMock.mockResolvedValue({ status: 'sendable' });
    const resumed = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(resumed.sent).toBe(1);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
  });

  it('an unreadable suppression store sends nothing', async () => {
    checkAddressMock.mockResolvedValue({ status: 'unknown' });
    const summary = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(checkAddressMock).toHaveBeenCalled();
    expect(sesSendMock).not.toHaveBeenCalled();
    expect(summary.notDelivered).toBe(1);
  });

  it('a recipient who unsubscribed (trialNotices off) gets nothing; the master email switch too', async () => {
    seedPrefs('user-admin', { trialNotices: false });
    const a = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(a.optedOut).toBe(1);
    expect(sesSendMock).not.toHaveBeenCalled();

    seedPrefs('user-admin', { email: false });
    const b = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(b.optedOut).toBe(1);
    expect(sesSendMock).not.toHaveBeenCalled();

    seedPrefs('user-admin'); // control
    expect((await runTrialLifecycleEmails(DAY10, {}, ENABLED)).sent).toBe(1);
  });

  it('skips quiet hours without consuming the send, and delivers on a later scan', async () => {
    seedPrefs('user-admin', { dndStart: '17:00', dndEnd: '18:00' });
    const quiet = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(quiet.quietHours).toBe(1);
    expect(sesSendMock).not.toHaveBeenCalled();
    expect(markerKeys()).toEqual([]);

    const later = new Date(DAY10.getTime() + 2 * 60 * 60 * 1000); // quiet window over
    expect((await runTrialLifecycleEmails(later, {}, ENABLED)).sent).toBe(1);
  });
});

describe('who and when', () => {
  it('mails admins only', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([ADMIN, MEMBER]);
    seedPrefs('user-member');
    await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(sentRaw()).toContain('admin@example.com');
    expect(sentRaw()).not.toContain('member@example.com');
  });

  it('counts noRecipient when no admin has an address', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([MEMBER]);
    const summary = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(summary.noRecipient).toBe(1);
    expect(sesSendMock).not.toHaveBeenCalled();
  });

  it('sends nothing too early, too late, or to a household that has subscribed', async () => {
    await runTrialLifecycleEmails(TOO_EARLY, {}, ENABLED);
    await runTrialLifecycleEmails(TOO_LATE, {}, ENABLED);
    expect(sesSendMock).not.toHaveBeenCalled();

    // Sabotage: the household subscribes during the trial.
    seedHousehold({ status: 'trialing', stripeSubscriptionId: 'sub_1', planId: 'garden' });
    const subscribed = await runTrialLifecycleEmails(DAY14, {}, ENABLED);
    expect(subscribed.due).toBe(0);
    expect(sesSendMock).not.toHaveBeenCalled();

    seedHousehold(); // control
    expect((await runTrialLifecycleEmails(DAY14, {}, ENABLED)).sent).toBe(1);
  });

  it('sends each email once per admin, never twice', async () => {
    await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    const again = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(again.alreadySent).toBe(1);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    // Day 14 is its own email.
    await runTrialLifecycleEmails(DAY14, {}, ENABLED);
    expect(sesSendMock).toHaveBeenCalledTimes(2);
    expect(markerKeys().sort()).toEqual([
      'HOUSEHOLD#hh-1|TRIAL_EMAIL#trial_day10#user-admin',
      'HOUSEHOLD#hh-1|TRIAL_EMAIL#trial_day14#user-admin',
    ]);
  });

  it('keeps a household failure from stopping the rest', async () => {
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh-bad', 'hh-1']);
    vi.mocked(householdService.getHouseholdMembers).mockImplementation((id: string) =>
      id === 'hh-bad' ? Promise.reject(new Error('ddb down')) : Promise.resolve([ADMIN])
    );
    rows.set('HOUSEHOLD#hh-bad|METADATA', { planId: 'seedling', noCardTrialEndsAt: ENDS });
    const summary = await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(summary.errors).toBe(1);
    expect(summary.sent).toBe(1);
  });
});

describe('what is sent', () => {
  it('is a multipart message with List-Unsubscribe, a reply address, and the unsubscribe link', async () => {
    await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    const raw = sentRaw();
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('Reply-To: support@familygreenhouse.net');
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(raw).toMatch(
      /List-Unsubscribe: <https:\/\/api\.familygreenhouse\.net\/notifications\/email\/unsubscribe\?t=tok-1/
    );
    expect(vi.mocked(capability.mintUnsubscribeToken)).toHaveBeenCalledWith(
      'user-admin',
      'trial_notices'
    );
  });

  it('still sends, without the header, when the unsubscribe token cannot be minted', async () => {
    vi.mocked(capability.mintUnsubscribeToken).mockResolvedValue({
      status: 'unavailable',
      reason: 'ddb',
    });
    await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect(sentRaw()).not.toContain('List-Unsubscribe');
  });

  it('reads the facts once per household, for the trial window clamped to now', async () => {
    await runTrialLifecycleEmails(DAY10, {}, ENABLED);
    expect(factsModule.readTrialFacts).toHaveBeenCalledTimes(1);
    expect(factsModule.readTrialFacts).toHaveBeenCalledWith('hh-1', STARTED, DAY10.toISOString());
    vi.mocked(factsModule.readTrialFacts).mockClear();
    await runTrialLifecycleEmails(DAY14, {}, ENABLED);
    expect(factsModule.readTrialFacts).toHaveBeenCalledWith('hh-1', STARTED, ENDS);
  });
});
