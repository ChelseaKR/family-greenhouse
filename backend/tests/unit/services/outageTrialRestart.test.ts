/**
 * The one-time trial restart for outage households (ADR 0027, amendment of
 * 2026-11-19), against an in-memory table that evaluates the module's own
 * write conditions. A refusal test is only meaningful beside a positive
 * control, so every fixture starts from one that IS restarted and changes one
 * thing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>()),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/utils/cognito.js', () => ({
  cognito: { send: vi.fn() },
  USER_POOL_ID: 'test-pool',
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({ sendEmailAccepted: vi.fn() }));
vi.mock('../../../src/services/emailSuppression.js', () => ({ checkAddress: vi.fn() }));
vi.mock('../../../src/services/notificationPrefs.js', () => ({ getPreferences: vi.fn() }));
vi.mock('../../../src/services/householdService.js', () => ({
  getHousehold: vi.fn(),
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
}));
vi.mock('../../../src/services/billing.js', () => ({ getHouseholdSubscription: vi.fn() }));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as billing from '../../../src/services/billing.js';
import * as householdService from '../../../src/services/householdService.js';
import * as notificationPrefs from '../../../src/services/notificationPrefs.js';
import {
  RESTART_ID,
  planOutageTrialRestart,
  restartCondition,
  restartDates,
  restartEligibility,
  restartOutageTrial,
  type RestartPlan,
} from '../../../src/services/outageTrialRestart.js';
import type { HouseholdSubscription } from '../../../src/services/billing.js';
import type { HouseholdMember } from '../../../src/models/types.js';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const HH = 'hh-1';
const META = `HOUSEHOLD#${HH}|METADATA`;
const MARKER = `SERVICE_NOTICE#${RESTART_ID}|HOUSEHOLD#${HH}`;
/** Ended 2026-11-04, inside the outage window. */
const OLD_END = '2026-11-04T17:00:00.000Z';

// ---------------------------------------------------------------------------
// In-memory table with a condition evaluator for the shapes this module writes
// ---------------------------------------------------------------------------

type Item = Record<string, unknown>;
interface Cmd {
  kind: 'Get' | 'Query' | 'TransactWrite';
  input: Record<string, unknown>;
}

let table: Map<string, Item>;
let commands: Cmd[];

const key = (pk: unknown, sk: unknown) => `${pk}|${sk}`;

function evalPart(
  part: string,
  item: Item | undefined,
  names: Record<string, string>,
  values: Record<string, unknown>
): boolean {
  const attr = (ref: string) => names[ref] ?? ref;
  let m = /^attribute_exists\((\S+)\)$/.exec(part);
  if (m) return item !== undefined && attr(m[1]!) in item;
  m = /^attribute_not_exists\((\S+)\)$/.exec(part);
  if (m) return item === undefined || !(attr(m[1]!) in item);
  m = /^\(attribute_not_exists\((\S+)\) OR (\S+) = (\S+)\)$/.exec(part);
  if (m) {
    return item === undefined || !(attr(m[1]!) in item) || item[attr(m[2]!)] === values[m[3]!];
  }
  m = /^(\S+) = (\S+)$/.exec(part);
  if (m) return item !== undefined && item[attr(m[1]!)] === values[m[2]!];
  throw new Error(`fake table cannot evaluate: ${part}`);
}

function conditionHolds(
  expr: string | undefined,
  item: Item | undefined,
  names: Record<string, string> = {},
  values: Record<string, unknown> = {}
): boolean {
  if (!expr) return true;
  return expr.split(' AND ').every((part) => evalPart(part.trim(), item, names, values));
}

function installFakeTable(): void {
  table = new Map();
  commands = [];
  vi.mocked(dynamodb.send).mockImplementation(async (command: unknown) => {
    const cmd = command as Cmd;
    commands.push(cmd);
    const input = cmd.input as Record<string, never>;
    if (cmd.kind === 'Get') {
      const k = input.Key as { PK: string; SK: string };
      return { Item: table.get(key(k.PK, k.SK)) };
    }
    if (cmd.kind === 'Query') {
      const vals = input.ExpressionAttributeValues as Record<string, string>;
      const count = [...table.keys()].filter((k) => {
        const [pk, sk] = k.split('|');
        return pk === vals[':pk'] && sk!.startsWith(vals[':sk']!);
      }).length;
      return { Count: count };
    }
    // TransactWrite: all conditions first, then all writes.
    const items = input.TransactItems as Array<Record<string, Record<string, never>>>;
    const reasons = items.map((entry) => {
      const op = entry.Update ?? entry.Put!;
      const k = (op.Key ?? op.Item) as { PK: string; SK: string };
      const ok = conditionHolds(
        op.ConditionExpression,
        table.get(key(k.PK, k.SK)),
        op.ExpressionAttributeNames,
        op.ExpressionAttributeValues
      );
      return { Code: ok ? 'None' : 'ConditionalCheckFailed' };
    });
    if (reasons.some((r) => r.Code !== 'None')) {
      const err = new Error('Transaction cancelled') as Error & { CancellationReasons: unknown };
      err.name = 'TransactionCanceledException';
      err.CancellationReasons = reasons;
      throw err;
    }
    for (const entry of items) {
      if (entry.Put) {
        const it = entry.Put.Item as Item;
        table.set(key(it.PK, it.SK), { ...it });
      } else {
        const op = entry.Update!;
        const k = op.Key as { PK: string; SK: string };
        const row = { ...(table.get(key(k.PK, k.SK)) ?? {}) };
        const names = op.ExpressionAttributeNames as Record<string, string>;
        const values = op.ExpressionAttributeValues as Record<string, unknown>;
        const sets = (op.UpdateExpression as string).replace(/^SET /, '').split(', ');
        for (const set of sets) {
          const [lhs, rhs] = set.split(' = ');
          row[names[lhs!] ?? lhs!] = values[rhs!];
        }
        table.set(key(k.PK, k.SK), row);
      }
    }
    return {};
  });
}

/** What `billing.getHouseholdSubscription` reads off the row (the fields used). */
function subFromRow(row: Item | undefined): HouseholdSubscription {
  if (!row) return { planId: 'seedling' };
  return {
    planId: (row.planId as HouseholdSubscription['planId']) ?? 'seedling',
    status: row.subscriptionStatus as string | undefined,
    stripeSubscriptionId: row.stripeSubscriptionId as string | undefined,
    lifetimePlanId: row.lifetimePlanId as HouseholdSubscription['lifetimePlanId'],
    appStore: row.appStore as HouseholdSubscription['appStore'],
    noCardTrialEndsAt: row.noCardTrialEndsAt as string | undefined,
    giftPlanId: row.giftPlanId as HouseholdSubscription['giftPlanId'],
    giftEndsAt: row.giftEndsAt as string | undefined,
  };
}

function seedHousehold(extra: Item = {}): void {
  table.set(META, {
    PK: `HOUSEHOLD#${HH}`,
    SK: 'METADATA',
    entityType: 'Household',
    id: HH,
    createdAt: '2026-10-21T17:00:00.000Z',
    noCardTrialStartedAt: '2026-10-21T17:00:00.000Z',
    noCardTrialEndsAt: OLD_END,
    ...extra,
  });
}

const admin = (userId: string, email = `${userId}@example.com`): HouseholdMember => ({
  householdId: HH,
  userId,
  name: 'Sam',
  email,
  role: 'admin',
  joinedAt: '2026-10-21T17:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  installFakeTable();
  vi.mocked(householdService.getHousehold).mockImplementation(async (id) =>
    table.has(`HOUSEHOLD#${id}|METADATA`)
      ? { id, name: 'x', createdAt: '2026-10-21T17:00:00.000Z', createdBy: 'u1' }
      : null
  );
  vi.mocked(billing.getHouseholdSubscription).mockImplementation(async (id) =>
    subFromRow(table.get(`HOUSEHOLD#${id}|METADATA`))
  );
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([
    admin('u1'),
    { ...admin('u2'), role: 'member' },
  ]);
  vi.mocked(notificationPrefs.getPreferences).mockResolvedValue({
    email: true,
    trialNotices: true,
  } as NotificationPreferences);
});

async function planOk(): Promise<RestartPlan> {
  const plan = await planOutageTrialRestart(HH, NOW);
  if (!plan.ok) throw new Error(`expected a plan, got ${plan.reason}`);
  return plan;
}

// ---------------------------------------------------------------------------

describe('restartDates', () => {
  it('starts now and ends 14 days later', () => {
    expect(restartDates(NOW)).toEqual({
      startedAt: '2026-11-21T12:00:00.000Z',
      endsAt: '2026-12-05T12:00:00.000Z',
    });
  });
});

describe('restartEligibility', () => {
  const ended: HouseholdSubscription = { planId: 'seedling', noCardTrialEndsAt: OLD_END };

  it('accepts a trial that ended during the outage, on no paid plan (positive control)', () => {
    expect(restartEligibility(ended, NOW)).toEqual({
      ok: true,
      trial: { startedAt: '2026-10-21T17:00:00.000Z', endedAt: OLD_END },
    });
  });

  it.each([
    ['no trial at all', { noCardTrialEndsAt: undefined }, 'no_trial'],
    ['a trial still running', { noCardTrialEndsAt: '2026-11-25T00:00:00.000Z' }, 'trial_active'],
    ['a Stripe status', { status: 'canceled' }, 'paid_stripe'],
    ['a Stripe subscription id', { stripeSubscriptionId: 'sub_1' }, 'paid_stripe'],
    ['a lifetime purchase', { lifetimePlanId: 'garden' }, 'paid_stripe'],
    ['a paid plan on file', { planId: 'garden' }, 'paid_stripe'],
    [
      'a running gift',
      { giftPlanId: 'garden', giftEndsAt: '2026-12-21T00:00:00.000Z' },
      'paid_gift',
    ],
    [
      'an App Store subscription',
      {
        appStore: {
          planId: 'garden',
          productId: 'net.familygreenhouse.app.garden.monthly',
          expiresAt: '2026-12-21T00:00:00.000Z',
          environment: 'Production',
        },
      },
      'paid_app_store',
    ],
    [
      'a lapsed App Store subscription',
      {
        appStore: {
          planId: 'garden',
          productId: 'net.familygreenhouse.app.garden.monthly',
          expiresAt: '2026-11-01T00:00:00.000Z',
          environment: 'Production',
        },
      },
      'paid_app_store',
    ],
    [
      'App Store attributes that do not parse',
      { appStore: { productId: 'unknown' } as HouseholdSubscription['appStore'] },
      'paid_app_store',
    ],
    ['an unreadable end date', { noCardTrialEndsAt: 'soon' }, 'unreadable_end'],
    [
      'an end before the outage',
      { noCardTrialEndsAt: '2026-09-03T23:59:59.000Z' },
      'outside_window',
    ],
    [
      'an end after the outage',
      { noCardTrialEndsAt: '2026-11-20T00:00:00.000Z' },
      'outside_window',
    ],
  ] as const)('refuses %s', (_label, change, reason) => {
    const sub = { ...ended, ...change } as HouseholdSubscription;
    expect(restartEligibility(sub, NOW)).toEqual({ ok: false, reason });
  });

  it('accepts a gift that has already ended', () => {
    const sub = { ...ended, giftPlanId: 'garden', giftEndsAt: '2026-10-01T00:00:00.000Z' };
    expect(restartEligibility(sub as HouseholdSubscription, NOW).ok).toBe(true);
  });
});

describe('planOutageTrialRestart (dry run)', () => {
  it('reads only, and reports the dates and counts', async () => {
    seedHousehold();
    const plan = await planOk();
    expect(plan).toMatchObject({
      oldTrial: { endedAt: OLD_END },
      startedAt: '2026-11-21T12:00:00.000Z',
      endsAt: '2026-12-05T12:00:00.000Z',
      day10From: '2026-12-01T12:00:00.000Z',
      day14Until: '2026-12-08T12:00:00.000Z',
      trialEmailMarkers: 0,
      admins: 1,
      adminsReachable: 1,
    });
    expect(commands.map((c) => c.kind).every((k) => k === 'Get' || k === 'Query')).toBe(true);
    expect(table.get(META)?.noCardTrialEndsAt).toBe(OLD_END);
    expect(table.has(MARKER)).toBe(false);
  });

  it('counts earlier trial-email markers and admins who would not be mailed', async () => {
    seedHousehold();
    table.set(`HOUSEHOLD#${HH}|TRIAL_EMAIL#trial_day10#u1`, { status: 'sent' });
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([
      admin('u1'),
      admin('u3', 'no-address'),
    ]);
    vi.mocked(notificationPrefs.getPreferences).mockResolvedValue({
      email: true,
      trialNotices: false,
    } as NotificationPreferences);
    const plan = await planOk();
    expect(plan.trialEmailMarkers).toBe(1);
    expect(plan.admins).toBe(2);
    expect(plan.adminsReachable).toBe(0);
  });

  it('refuses a household that does not exist', async () => {
    expect(await planOutageTrialRestart('missing', NOW)).toEqual({
      ok: false,
      reason: 'no_household',
    });
  });

  it('refuses a household on a paid plan, from the row', async () => {
    seedHousehold({ stripeSubscriptionId: 'sub_1', subscriptionStatus: 'active' });
    expect(await planOutageTrialRestart(HH, NOW)).toEqual({ ok: false, reason: 'paid_stripe' });
  });

  it('refuses a household that was already restarted', async () => {
    seedHousehold();
    table.set(MARKER, { PK: 'x' });
    expect(await planOutageTrialRestart(HH, NOW)).toEqual({
      ok: false,
      reason: 'already_restarted',
    });
  });
});

describe('restartOutageTrial (--confirm)', () => {
  it('writes the new dates and the marker', async () => {
    seedHousehold({ planId: 'seedling' });
    const plan = await planOk();
    expect(await restartOutageTrial(HH, plan, NOW)).toEqual({
      status: 'restarted',
      startedAt: '2026-11-21T12:00:00.000Z',
      endsAt: '2026-12-05T12:00:00.000Z',
    });
    expect(table.get(META)).toMatchObject({
      noCardTrialStartedAt: '2026-11-21T12:00:00.000Z',
      noCardTrialEndsAt: '2026-12-05T12:00:00.000Z',
      planId: 'seedling',
      createdAt: '2026-10-21T17:00:00.000Z',
    });
    expect(table.get(MARKER)).toMatchObject({
      householdId: HH,
      previousEndsAt: OLD_END,
      startedAt: '2026-11-21T12:00:00.000Z',
      endsAt: '2026-12-05T12:00:00.000Z',
      restartedAt: NOW.toISOString(),
    });
    // The restarted household now reads as on a running trial.
    const after = subFromRow(table.get(META));
    expect(restartEligibility(after, NOW)).toEqual({ ok: false, reason: 'trial_active' });
  });

  it('the marker blocks a second restart, whatever the row says later', async () => {
    seedHousehold();
    await restartOutageTrial(HH, await planOk(), NOW);
    // Put the old end date back, as if the restart had never been written:
    // only the marker is left to refuse.
    table.set(META, { ...table.get(META)!, noCardTrialEndsAt: OLD_END });
    expect(await planOutageTrialRestart(HH, NOW)).toEqual({
      ok: false,
      reason: 'already_restarted',
    });
  });

  it('two runs racing from the same read write once', async () => {
    seedHousehold();
    const first = await planOk();
    const second = await planOk();
    expect((await restartOutageTrial(HH, first, NOW)).status).toBe('restarted');
    const later = new Date(NOW.getTime() + 60_000);
    expect(await restartOutageTrial(HH, { ...second, endsAt: 'other' }, later)).toEqual({
      status: 'already_restarted',
    });
    expect(table.get(META)?.noCardTrialEndsAt).toBe('2026-12-05T12:00:00.000Z');
    expect(table.get(MARKER)?.restartedAt).toBe(NOW.toISOString());
  });

  it.each([
    ['the trial end moved', { noCardTrialEndsAt: '2026-11-05T17:00:00.000Z' }],
    ['a Stripe subscription arrived', { stripeSubscriptionId: 'sub_1' }],
    ['a Stripe status arrived', { subscriptionStatus: 'active' }],
    ['a lifetime purchase arrived', { lifetimePlanId: 'garden' }],
    ['an App Store purchase arrived', { appStore: { planId: 'garden' } }],
    ['the plan changed', { planId: 'garden' }],
    ['a gift was redeemed', { giftPlanId: 'garden', giftEndsAt: '2027-01-01T00:00:00.000Z' }],
  ])('writes nothing when %s after the read', async (_label, change) => {
    seedHousehold();
    const plan = await planOk();
    table.set(META, { ...table.get(META)!, ...change });
    expect(await restartOutageTrial(HH, plan, NOW)).toEqual({ status: 'changed' });
    expect(table.get(META)?.noCardTrialStartedAt).toBe('2026-10-21T17:00:00.000Z');
    expect(table.has(MARKER)).toBe(false);
  });

  it('rethrows a failure that is not a condition', async () => {
    seedHousehold();
    const plan = await planOk();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));
    await expect(restartOutageTrial(HH, plan, NOW)).rejects.toThrow('throttled');
  });
});

describe('restartCondition', () => {
  it('names no tier and pins the read values', () => {
    const c = restartCondition({
      planId: 'seedling',
      noCardTrialEndsAt: OLD_END,
      giftPlanId: 'garden',
      giftEndsAt: '2026-10-01T00:00:00.000Z',
    });
    expect(c.ExpressionAttributeValues).toEqual({
      ':oldEnd': OLD_END,
      ':planId': 'seedling',
      ':giftPlanId': 'garden',
      ':giftEndsAt': '2026-10-01T00:00:00.000Z',
    });
    for (const attr of [
      'subscriptionStatus',
      'stripeSubscriptionId',
      'lifetimePlanId',
      'appStore',
    ]) {
      expect(c.ConditionExpression).toContain(`attribute_not_exists(#${attr})`);
    }
  });
});
