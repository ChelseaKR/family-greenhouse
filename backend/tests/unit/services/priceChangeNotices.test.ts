import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../src/services/householdService.js', () => ({
  listAllHouseholdIds: vi.fn(),
  getHouseholdMembers: vi.fn(),
}));
vi.mock('../../../src/services/billing.js', () => ({ getHouseholdSubscription: vi.fn() }));
vi.mock('../../../src/utils/auditLog.js', () => ({ audit: vi.fn() }));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as emailNotifier from '../../../src/services/emailNotifier.js';
import * as householdService from '../../../src/services/householdService.js';
import * as billing from '../../../src/services/billing.js';
import { audit } from '../../../src/utils/auditLog.js';
import {
  affectedHouseholdIds,
  sendPriceChangeNotice,
} from '../../../src/services/priceChangeNotices.js';
import type { PriceChangeAnnouncement } from '../../../src/models/priceChangeAnnouncement.js';
import type { HouseholdMember } from '../../../src/models/types.js';

interface FakeCommand {
  kind: 'Put' | 'Delete';
  input: { Key?: { PK?: string; SK?: string }; Item?: Record<string, unknown> };
}

/** Keys with a live marker, simulating the conditional Put's own semantics:
 *  a Put with `attribute_not_exists(PK)` fails once the key is present. */
let claimed: Set<string>;

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

function installFakeTable(): void {
  claimed = new Set();
  vi.mocked(dynamodb.send).mockImplementation(async (command: unknown) => {
    const cmd = command as FakeCommand;
    const key = keyOf(cmd);
    if (cmd.kind === 'Put') {
      if (claimed.has(key)) throw conditionalFailure();
      claimed.add(key);
      return {};
    }
    if (cmd.kind === 'Delete') {
      claimed.delete(key);
      return {};
    }
    throw new Error(`unexpected command kind: ${cmd.kind}`);
  });
}

function admin(userId: string, email = `${userId}@example.com`): HouseholdMember {
  return { householdId: 'unused', userId, name: userId, email, role: 'admin' } as HouseholdMember;
}
function member(userId: string): HouseholdMember {
  return {
    householdId: 'unused',
    userId,
    name: userId,
    email: `${userId}@example.com`,
    role: 'member',
  } as HouseholdMember;
}

const ANNOUNCEMENT: PriceChangeAnnouncement = {
  id: 'garden-monthly-2026-11-01',
  planId: 'garden',
  interval: 'month',
  summary: 'Garden monthly is moving from $4.99 to $5.99 to keep pace with vendor cost.',
  oldPriceUsd: 4.99,
  newPriceUsd: 5.99,
  effectiveOn: '2026-11-01',
};
const TODAY = '2026-10-18';

beforeEach(() => {
  installFakeTable();
  vi.mocked(emailNotifier.sendEmail).mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('affectedHouseholdIds', () => {
  it('keeps only households on the plan, with a live Stripe subscription in a paying status', async () => {
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue([
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
    ]);
    vi.mocked(billing.getHouseholdSubscription).mockImplementation(async (id: string) => {
      const rows: Record<
        string,
        ReturnType<typeof billing.getHouseholdSubscription> extends Promise<infer T> ? T : never
      > = {
        h1: { planId: 'garden', stripeSubscriptionId: 'sub_1', status: 'active' } as never,
        h2: { planId: 'greenhouse', stripeSubscriptionId: 'sub_2', status: 'active' } as never, // wrong plan
        h3: { planId: 'garden', stripeSubscriptionId: 'sub_3', status: 'canceled' } as never, // not paying
        h4: { planId: 'garden', status: 'active' } as never, // no subscription id (no-card trial)
        h5: { planId: 'garden', stripeSubscriptionId: 'sub_5', status: 'trialing' } as never,
      };
      return rows[id];
    });

    const affected = await affectedHouseholdIds('garden');
    expect(affected.sort()).toEqual(['h1', 'h5']);
  });
});

describe('sendPriceChangeNotice: validation', () => {
  it('throws on an invalid announcement and touches nothing', async () => {
    await expect(
      sendPriceChangeNotice({ ...ANNOUNCEMENT, effectiveOn: '2026-10-20' }, { today: TODAY })
    ).rejects.toThrow(/not ready to send/);
    expect(householdService.listAllHouseholdIds).not.toHaveBeenCalled();
  });
});

describe('sendPriceChangeNotice: who gets mailed', () => {
  beforeEach(() => {
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh-affected', 'hh-other']);
    vi.mocked(billing.getHouseholdSubscription).mockImplementation(async (id: string) =>
      id === 'hh-affected'
        ? ({ planId: 'garden', stripeSubscriptionId: 'sub_1', status: 'active' } as never)
        : ({ planId: 'greenhouse', stripeSubscriptionId: 'sub_2', status: 'active' } as never)
    );
    vi.mocked(householdService.getHouseholdMembers).mockImplementation(async (id: string) =>
      id === 'hh-affected' ? [admin('a1'), admin('a2'), member('m1')] : [admin('other-admin')]
    );
  });

  it('emails every admin of an affected household, and nobody else', async () => {
    const summary = await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });

    expect(summary.householdsAffected).toBe(1);
    expect(summary.recipientsNotified).toBe(2);
    expect(summary.recipientsFailed).toBe(0);
    expect(vi.mocked(emailNotifier.sendEmail)).toHaveBeenCalledTimes(2);
    const recipients = vi.mocked(emailNotifier.sendEmail).mock.calls.map((c) => c[0].to);
    expect(recipients.sort()).toEqual(['a1@example.com', 'a2@example.com']);
  });

  it('audits exactly one event per admin actually mailed', async () => {
    await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      'billing.price_change_notice_sent',
      expect.objectContaining({ householdId: 'hh-affected' })
    );
  });

  it('is idempotent: re-running the same announcement re-sends nothing', async () => {
    await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });
    vi.mocked(emailNotifier.sendEmail).mockClear();

    const secondRun = await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });

    expect(secondRun.recipientsNotified).toBe(0);
    expect(secondRun.recipientsSkippedAlreadyNotified).toBe(2);
    expect(vi.mocked(emailNotifier.sendEmail)).not.toHaveBeenCalled();
  });

  it('a different announcement id is not blocked by an earlier one’s markers', async () => {
    await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });
    vi.mocked(emailNotifier.sendEmail).mockClear();

    const secondNotice: PriceChangeAnnouncement = {
      ...ANNOUNCEMENT,
      id: 'garden-monthly-2027-01-01',
    };
    const summary = await sendPriceChangeNotice(secondNotice, { today: TODAY });

    expect(summary.recipientsNotified).toBe(2);
  });

  it(
    'negative control: a failed send is not marked as sent, so a retry actually retries — ' +
      'proving the notice cannot be silently skipped',
    async () => {
      vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const firstRun = await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });
      expect(firstRun.recipientsNotified).toBe(1);
      expect(firstRun.recipientsFailed).toBe(1);
      // The failure must not have been counted as an audited send.
      expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);

      vi.mocked(emailNotifier.sendEmail).mockResolvedValue(true);
      const retry = await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });

      // The one that failed is retried and delivered; the one that already
      // succeeded is skipped, not re-mailed.
      expect(retry.recipientsNotified).toBe(1);
      expect(retry.recipientsSkippedAlreadyNotified).toBe(1);
      expect(retry.recipientsFailed).toBe(0);
    }
  );

  it('a household with no admin recipients is affected but nobody is mailed', async () => {
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh-no-admin']);
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'garden',
      stripeSubscriptionId: 'sub_9',
      status: 'active',
    } as never);
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([member('m1')]);

    const summary = await sendPriceChangeNotice(ANNOUNCEMENT, { today: TODAY });
    expect(summary.householdsAffected).toBe(1);
    expect(summary.recipientsNotified).toBe(0);
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });
});
