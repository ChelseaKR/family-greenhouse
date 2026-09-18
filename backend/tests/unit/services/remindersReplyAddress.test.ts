/**
 * The reminder side of reply-to-act (#667, ADR 0031): when a reminder carries
 * a reply address, what that address is bound to — and that with the feature
 * off (the default) the reminder is exactly what it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

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
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
  getHousehold: vi.fn(async () => null),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  getTasksDueBy: vi.fn(),
  getActiveVacationMap: vi.fn(async () => new Map()),
}));
vi.mock('../../../src/services/plantService.js', () => ({ getPlants: vi.fn() }));
vi.mock('../../../src/services/notificationPrefs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/notificationPrefs.js')>(
    '../../../src/services/notificationPrefs.js'
  );
  return { ...actual, getPreferences: vi.fn() };
});
vi.mock('../../../src/services/pestAlerts.js', () => ({
  evaluatePestAlerts: vi.fn(),
  wasAlerted: vi.fn(async () => false),
  markAlerted: vi.fn(),
}));
vi.mock('../../../src/services/notifier.js', () => ({
  sendToUser: vi.fn(async () => ({
    delivered: true,
    dndSuppressedOnly: false,
    channels: { browser: 'delivered', email: 'delivered', sms: 'skipped' },
  })),
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as householdService from '../../../src/services/householdService.js';
import * as taskService from '../../../src/services/taskService.js';
import * as plantService from '../../../src/services/plantService.js';
import * as notificationPrefs from '../../../src/services/notificationPrefs.js';
import * as notifier from '../../../src/services/notifier.js';
import { remindHousehold } from '../../../src/services/reminders.js';
import { digestOf } from '../../../src/services/emailReplyTokens.js';
import { tokenFromRecipient } from '../../../src/services/email/replyAddress.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const DOMAIN = 'familygreenhouse.net';
const ORIGINAL_ENV = process.env;

const member = {
  householdId: 'hh',
  userId: 'u1',
  name: 'Ada',
  email: 'ada@x.com',
  role: 'admin' as const,
  joinedAt: '',
};

let puts: Array<Record<string, unknown>> = [];
let failTokenWrites = false;

function prefs(over: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    userId: 'u1',
    browser: false,
    email: true,
    sms: false,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    pestAlerts: false,
    weeklyDigest: true,
    phoneVerified: false,
    updatedAt: '',
    ...over,
  } as NotificationPreferences;
}

function task(id: string, plantId: string, offsetDays: number, assignedTo: string | null) {
  return {
    id,
    plantId,
    nextDue: iso(offsetDays * DAY),
    assignedTo,
    type: 'water',
    customType: null,
  };
}

async function setup(tasks: ReturnType<typeof task>[], memberPrefs = prefs()) {
  const plants = [...new Set(tasks.map((t) => t.plantId))].map((id) => ({
    id,
    name: `Plant ${id}`,
  }));
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([member] as never);
  vi.mocked(taskService.getTasksDueBy).mockResolvedValue(tasks as never);
  vi.mocked(plantService.getPlants).mockResolvedValue(plants as never);
  vi.mocked(notificationPrefs.getPreferences).mockResolvedValue(memberPrefs);
}

function payload() {
  const calls = vi.mocked(notifier.sendToUser).mock.calls;
  return calls[calls.length - 1][1] as { body: string; emailReplyTo?: string };
}

const tokenPuts = () => puts.filter((item) => String(item.PK).startsWith('EMAILREPLY#'));

beforeEach(() => {
  vi.clearAllMocks();
  puts = [];
  failTokenWrites = false;
  process.env = { ...ORIGINAL_ENV };
  delete process.env.EMAIL_REPLY_ACTIONS_ENABLED;
  delete process.env.EMAIL_REPLY_DOMAIN;
  vi.mocked(dynamodb.send).mockImplementation(async (command: unknown) => {
    const { kind, input } = command as { kind: string; input: { Item?: Record<string, unknown> } };
    if (kind === 'Put' && input.Item) {
      if (failTokenWrites && String(input.Item.PK).startsWith('EMAILREPLY#')) {
        throw new Error('ProvisionedThroughputExceededException');
      }
      puts.push(input.Item);
    }
    return {} as never;
  });
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

function enable() {
  process.env.EMAIL_REPLY_ACTIONS_ENABLED = 'true';
  process.env.EMAIL_REPLY_DOMAIN = DOMAIN;
}

describe('reminder reply address', () => {
  it('is absent by default: no token, no Reply-To override, no hint, dashes on up-for-grabs rows', async () => {
    await setup([task('t1', 'p1', -1, 'u1'), task('t2', 'p2', -2, null)]);
    await remindHousehold('hh', NOW);

    expect(tokenPuts()).toHaveLength(0);
    const sent = payload();
    expect(sent).not.toHaveProperty('emailReplyTo');
    expect(sent.body).not.toContain('Reply to this email');
    expect(sent.body).toContain('- Plant p2 — water, 2 days overdue');
  });

  it('binds a hashed token to exactly the rows the email numbers, in that order', async () => {
    enable();
    await setup([
      task('t1', 'p1', -1, 'u1'),
      task('t2', 'p2', -2, null),
      task('t3', 'p3', -5, 'u1'),
    ]);
    await remindHousehold('hh', NOW);

    const sent = payload();
    expect(sent.emailReplyTo).toMatch(/^care\+[0-9a-f]{40}@familygreenhouse\.net$/);
    const token = tokenFromRecipient(sent.emailReplyTo!, DOMAIN)!;

    const [row] = tokenPuts();
    expect(row.PK).toBe(`EMAILREPLY#${digestOf(token)}`);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ userId: 'u1', householdId: 'hh', locale: 'en', timeZone: 'UTC' });
    // Own rows first (most overdue first), then the up-for-grabs row numbered
    // after them — the same order the body prints.
    expect(row.tasks).toEqual([
      { taskId: 't3', expectedNextDue: iso(-5 * DAY) },
      { taskId: 't1', expectedNextDue: iso(-1 * DAY) },
      { taskId: 't2', expectedNextDue: iso(-2 * DAY) },
    ]);
    expect(sent.body).toContain('1. Plant p3 — water, 5 days overdue');
    expect(sent.body).toContain('2. Plant p1 — water, 1 day overdue');
    expect(sent.body).toContain('3. Plant p2 — water, 2 days overdue');
    expect(sent.body).toContain('Reply to this email with "done 1"');
  });

  it('binds only the rows the email lists, never the capped remainder', async () => {
    enable();
    await setup(Array.from({ length: 8 }, (_, i) => task(`t${i}`, `p${i}`, -(i + 1), 'u1')));
    await remindHousehold('hh', NOW);

    const [row] = tokenPuts();
    expect((row.tasks as unknown[]).length).toBe(6);
    expect(payload().body).toContain('Showing 6 of 8.');
  });

  it('uses the one-task hint when one task is listed', async () => {
    enable();
    await setup([task('t1', 'p1', -1, 'u1')]);
    await remindHousehold('hh', NOW);
    expect(payload().body).toContain('Reply to this email with "done"');
  });

  it('is not minted when this send has no email leg', async () => {
    enable();
    await setup([task('t1', 'p1', -1, 'u1')], prefs({ email: false, browser: true }));
    await remindHousehold('hh', NOW);
    expect(tokenPuts()).toHaveLength(0);
    expect(payload()).not.toHaveProperty('emailReplyTo');
  });

  it('falls back to the plain reminder when the token cannot be stored', async () => {
    enable();
    failTokenWrites = true;
    await setup([task('t1', 'p1', -1, 'u1')]);
    await remindHousehold('hh', NOW);

    const sent = payload();
    // A footer promising "reply done" must never go out without an address
    // that can act on it.
    expect(sent).not.toHaveProperty('emailReplyTo');
    expect(sent.body).not.toContain('Reply to this email');
    expect(vi.mocked(notifier.sendToUser)).toHaveBeenCalledTimes(1);
  });
});
