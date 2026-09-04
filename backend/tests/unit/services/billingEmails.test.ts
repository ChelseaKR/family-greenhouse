import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

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
vi.mock('../../../src/services/emailNotifier.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../src/services/householdService.js', () => ({ getHouseholdMembers: vi.fn() }));
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
  isValidTimeZone: vi.fn(() => true),
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as emailNotifier from '../../../src/services/emailNotifier.js';
import * as householdService from '../../../src/services/householdService.js';
import * as notificationPrefs from '../../../src/services/notificationPrefs.js';
import {
  dispatchBillingEmails,
  sendAccountDeletionEmail,
} from '../../../src/services/billingEmails.js';

interface FakeCommand {
  kind: 'Put' | 'Get' | 'Delete' | 'Update';
  input: {
    Key?: { PK?: string; SK?: string };
    Item?: Record<string, unknown>;
  };
}

/** Rows the fake table already holds, keyed `PK|SK`. */
let rows: Map<string, Record<string, unknown>>;
/** Keys whose conditional Put must fail, simulating a marker already taken. */
let claimedKeys: Set<string>;

function keyOf(cmd: FakeCommand): string {
  const key = cmd.input.Key ?? {
    PK: cmd.input.Item?.PK as string,
    SK: cmd.input.Item?.SK as string,
  };
  return `${key.PK}|${key.SK}`;
}

function conditionalFailure(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

function sent(): FakeCommand[] {
  return vi.mocked(dynamodb.send).mock.calls.map((call) => call[0] as unknown as FakeCommand);
}

function marker(kind: string, userId: string): string | undefined {
  return sent()
    .filter((c) => c.kind === 'Put')
    .map(keyOf)
    .find((k) => k.includes(`EMAIL#${kind}#${userId}`));
}

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  previousAttributes?: Record<string, unknown>
): Stripe.Event {
  return {
    id: 'evt_test',
    object: 'event',
    created: 1_756_000_000,
    livemode: false,
    type,
    data: { object, ...(previousAttributes ? { previous_attributes: previousAttributes } : {}) },
  } as unknown as Stripe.Event;
}

const paidInvoice = stripeEvent('invoice.paid', {
  customer: 'cus_1',
  currency: 'usd',
  amount_paid: 499,
  subscription_details: { metadata: { householdId: 'hh-1', planId: 'garden' } },
  lines: { data: [{ description: 'Garden × 1 month', period: { start: 1, end: 2 } }] },
});

const ADMIN = {
  householdId: 'hh-1',
  userId: 'user-admin',
  name: 'Sam',
  email: 'admin@example.com',
  role: 'admin' as const,
  joinedAt: '2026-01-01T00:00:00.000Z',
};
const SECOND_ADMIN = { ...ADMIN, userId: 'user-admin-2', email: 'admin2@example.com' };
const MEMBER = {
  ...ADMIN,
  userId: 'user-member',
  email: 'member@example.com',
  role: 'member' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
  claimedKeys = new Set();
  process.env.FRONTEND_URL = 'https://familygreenhouse.net';

  vi.mocked(dynamodb.send).mockImplementation((command: unknown) => {
    const cmd = command as FakeCommand;
    const key = keyOf(cmd);
    if (cmd.kind === 'Get') return Promise.resolve({ Item: rows.get(key) }) as never;
    if (cmd.kind === 'Put') {
      if (claimedKeys.has(key)) return Promise.reject(conditionalFailure()) as never;
      rows.set(key, cmd.input.Item ?? {});
      return Promise.resolve({}) as never;
    }
    return Promise.resolve({}) as never;
  });

  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([ADMIN, MEMBER]);
  vi.mocked(notificationPrefs.getPreferences).mockResolvedValue({
    userId: 'user-admin',
    browser: false,
    email: false,
    sms: false,
    phone: '',
    dndStart: '00:00',
    dndEnd: '23:59',
    timezone: 'America/Los_Angeles',
    pestAlerts: false,
    weeklyDigest: false,
    phoneVerified: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  vi.mocked(emailNotifier.sendEmail).mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.FRONTEND_URL;
});

describe('dispatchBillingEmails — who gets it', () => {
  it('sends the receipt to every admin and to no ordinary member', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([
      ADMIN,
      SECOND_ADMIN,
      MEMBER,
    ]);
    await dispatchBillingEmails(paidInvoice, 'charge');
    const recipients = vi.mocked(emailNotifier.sendEmail).mock.calls.map((c) => c[0].to);
    expect(recipients).toEqual(['admin@example.com', 'admin2@example.com']);
  });

  it('is transactional: it sends although every notification preference is off', async () => {
    // The prefs fixture has email:false, weeklyDigest:false and an all-day DND
    // window. None of that may suppress a billing email.
    await dispatchBillingEmails(paidInvoice, 'charge');
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('reads the recipient timezone off prefs and dates the email in it', async () => {
    const invoice = stripeEvent('invoice.upcoming', {
      customer: 'cus_1',
      currency: 'usd',
      amount_due: 499,
      // 2026-10-03T00:30Z — still 2 October in Los Angeles.
      next_payment_attempt: Math.floor(Date.parse('2026-10-03T00:30:00.000Z') / 1000),
      subscription_details: { metadata: { householdId: 'hh-1' } },
    });
    await dispatchBillingEmails(invoice, 'charge');
    expect(vi.mocked(emailNotifier.sendEmail).mock.calls[0][0].text).toContain('October 2, 2026');
  });

  it('sends nothing, loudly, when the household cannot be identified', async () => {
    const orphan = stripeEvent('customer.source.expiring', {
      customer: 'cus_unknown',
      brand: 'Visa',
      last4: '4242',
      exp_month: 9,
      exp_year: 2026,
    });
    await dispatchBillingEmails(orphan, 'charge');
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('resolves a card-expiring warning through the customer pointer a receipt taught it', async () => {
    await dispatchBillingEmails(paidInvoice, 'charge');
    // The receipt wrote STRIPE_CUSTOMER#cus_1 → hh-1.
    expect(rows.get('STRIPE_CUSTOMER#cus_1|METADATA')).toMatchObject({ householdId: 'hh-1' });

    vi.mocked(emailNotifier.sendEmail).mockClear();
    const expiring = stripeEvent('customer.source.expiring', {
      customer: 'cus_1',
      brand: 'Visa',
      last4: '4242',
      exp_month: 9,
      exp_year: 2026,
    });
    await dispatchBillingEmails(expiring, 'charge');
    expect(vi.mocked(emailNotifier.sendEmail).mock.calls[0][0].text).toContain('Visa ••••4242');
  });

  it('sends nothing when the household has no admin with an address', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([MEMBER]);
    await dispatchBillingEmails(paidInvoice, 'charge');
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });
});

describe('dispatchBillingEmails — exactly once', () => {
  it('a redelivered webhook does not send a second receipt', async () => {
    await dispatchBillingEmails(paidInvoice, 'charge');
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);

    const markerKey = marker('payment_receipt', 'user-admin');
    expect(markerKey).toBeDefined();
    // The finalized marker is what a real redelivery meets: status 'sent',
    // so the conditional Put fails.
    claimedKeys.add(markerKey as string);

    vi.mocked(emailNotifier.sendEmail).mockClear();
    await dispatchBillingEmails(paidInvoice, 'charge');
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('keys the marker per recipient, so one blocked admin does not mute the other', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([ADMIN, SECOND_ADMIN]);
    await dispatchBillingEmails(paidInvoice, 'charge');
    claimedKeys.add(marker('payment_receipt', 'user-admin') as string);

    vi.mocked(emailNotifier.sendEmail).mockClear();
    await dispatchBillingEmails(paidInvoice, 'charge');
    const recipients = vi.mocked(emailNotifier.sendEmail).mock.calls.map((c) => c[0].to);
    expect(recipients).toEqual(['admin2@example.com']);
  });

  it('takes its marker in the Stripe-event partition, under its own sort key', async () => {
    await dispatchBillingEmails(paidInvoice, 'charge');
    const put = sent().find((c) => c.kind === 'Put' && c.input.Item?.SK !== 'METADATA');
    expect(put?.input.Item).toMatchObject({
      PK: 'STRIPE_EVENT#evt_test',
      SK: 'EMAIL#payment_receipt#user-admin',
      entityType: 'BillingEmailMarker',
      status: 'sending',
    });
    // Never the ledger's own METADATA row: that one is written after the
    // subscription apply so a failed apply stays retryable.
    expect(sent().some((c) => keyOf(c) === 'STRIPE_EVENT#evt_test|METADATA')).toBe(false);
  });

  it('finalizes the marker once SES accepted the message', async () => {
    await dispatchBillingEmails(paidInvoice, 'charge');
    const update = sent().find((c) => c.kind === 'Update');
    expect(update?.input.Key).toEqual({
      PK: 'STRIPE_EVENT#evt_test',
      SK: 'EMAIL#payment_receipt#user-admin',
    });
    expect(sent().some((c) => c.kind === 'Delete')).toBe(false);
  });

  it('releases the marker on a dry run, so a resend can still deliver', async () => {
    vi.mocked(emailNotifier.sendEmail).mockResolvedValue(false);
    await dispatchBillingEmails(paidInvoice, 'charge');
    const del = sent().find((c) => c.kind === 'Delete');
    expect(del?.input.Key).toEqual({
      PK: 'STRIPE_EVENT#evt_test',
      SK: 'EMAIL#payment_receipt#user-admin',
    });
  });

  it('releases the marker when SES throws', async () => {
    vi.mocked(emailNotifier.sendEmail).mockRejectedValue(new Error('ses down'));
    await dispatchBillingEmails(paidInvoice, 'charge');
    expect(sent().some((c) => c.kind === 'Delete')).toBe(true);
  });
});

describe('dispatchBillingEmails — phases', () => {
  const deleted = stripeEvent('customer.subscription.deleted', {
    metadata: { householdId: 'hh-1' },
    customer: 'cus_1',
    ended_at: 1_758_592_000,
  });

  it('holds a cancellation confirmation back until the state-change phase', async () => {
    await dispatchBillingEmails(deleted, 'charge');
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();

    rows.set('HOUSEHOLD#hh-1|METADATA', { planId: 'seedling' });
    await dispatchBillingEmails(deleted, 'state_change');
    expect(vi.mocked(emailNotifier.sendEmail).mock.calls[0][0].text).toContain(
      'Your household is on the Seedling plan'
    );
  });

  it('does not dispatch a receipt during the state-change phase', async () => {
    await dispatchBillingEmails(paidInvoice, 'state_change');
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });
});

describe('dispatchBillingEmails — never breaks the webhook', () => {
  it('swallows a roster read failure rather than making Stripe redeliver', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockRejectedValue(new Error('ddb down'));
    await expect(dispatchBillingEmails(paidInvoice, 'charge')).resolves.toBeUndefined();
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('swallows a marker-store failure, and sends nothing on it', async () => {
    vi.mocked(dynamodb.send).mockRejectedValue(new Error('ddb down'));
    await expect(dispatchBillingEmails(paidInvoice, 'charge')).resolves.toBeUndefined();
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('has nothing to do for an event type it does not read', async () => {
    await dispatchBillingEmails(stripeEvent('customer.subscription.created', {}), 'charge');
    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });
});

describe('sendAccountDeletionEmail', () => {
  it('sends the confirmation and reports a real delivery', async () => {
    const delivered = await sendAccountDeletionEmail({
      email: 'gone@example.com',
      soleMemberHouseholds: 1,
      sharedHouseholds: 2,
    });
    expect(delivered).toBe(true);
    const message = vi.mocked(emailNotifier.sendEmail).mock.calls[0][0];
    expect(message.to).toBe('gone@example.com');
    expect(message.text).toContain('What we did NOT delete, and why:');
  });

  it('writes no marker into the partition the deletion just erased', async () => {
    await sendAccountDeletionEmail({
      email: 'gone@example.com',
      soleMemberHouseholds: 1,
      sharedHouseholds: 0,
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('reports a dry run as undelivered rather than as success', async () => {
    vi.mocked(emailNotifier.sendEmail).mockResolvedValue(false);
    await expect(
      sendAccountDeletionEmail({
        email: 'gone@example.com',
        soleMemberHouseholds: 0,
        sharedHouseholds: 1,
      })
    ).resolves.toBe(false);
  });

  it('never throws out of the deletion path', async () => {
    vi.mocked(emailNotifier.sendEmail).mockRejectedValue(new Error('ses down'));
    await expect(
      sendAccountDeletionEmail({
        email: 'gone@example.com',
        soleMemberHouseholds: 0,
        sharedHouseholds: 1,
      })
    ).resolves.toBe(false);
  });
});
