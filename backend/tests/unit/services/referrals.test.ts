/**
 * Refer-a-friend (ADR 0029) policy: which codes resolve to a grant (and the
 * anti-self-referral guard's effect end to end), and crediting the referrer
 * after a real signup. `referralCodes` (storage) and the read half of
 * `billing` are mocked; `hasLiveStripeSubscription` / `LIVE_SUBSCRIPTION_STATUSES`
 * stay real via `importActual`, same pattern `giftSubscriptions.test.ts` uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/utils/auditLog.js', () => ({ audit: vi.fn() }));

vi.mock('../../../src/services/billing.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/billing.js')>(
    '../../../src/services/billing.js'
  );
  return { ...actual, getHouseholdSubscription: vi.fn() };
});
vi.mock('../../../src/services/referralCodes.js', () => ({
  findReferralCodeOwner: vi.fn(),
  recordReferralEvent: vi.fn(),
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import { audit } from '../../../src/utils/auditLog.js';
import { getHouseholdSubscription } from '../../../src/services/billing.js';
import * as referralCodes from '../../../src/services/referralCodes.js';
import {
  creditReferralAfterSignup,
  resolveReferralGrant,
} from '../../../src/services/referrals.js';
import type { ReferralGrant } from '../../../src/services/referrals.js';

const OWNER = {
  code: 'RF0000000001',
  referrerUserId: 'user-referrer',
  referrerHouseholdId: 'hh-referrer',
  referrerEmail: 'referrer@gmail.com',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('resolveReferralGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found for a malformed code — never looks it up', async () => {
    const decision = await resolveReferralGrant({
      code: 'not-a-real-code',
      newUserId: 'user-new',
      newUserEmail: 'new@example.test',
    });
    expect(decision).toEqual({ ok: false, reason: 'not_found' });
    expect(referralCodes.findReferralCodeOwner).not.toHaveBeenCalled();
  });

  it('returns not_found for a well-formed but unknown code', async () => {
    vi.mocked(referralCodes.findReferralCodeOwner).mockResolvedValue(null);
    const decision = await resolveReferralGrant({
      code: 'RF0000000001',
      newUserId: 'user-new',
      newUserEmail: 'new@example.test',
    });
    expect(decision).toEqual({ ok: false, reason: 'not_found' });
  });

  it('resolves a valid code from a plausibly different person to a one-month Garden grant', async () => {
    vi.mocked(referralCodes.findReferralCodeOwner).mockResolvedValue(OWNER);
    const decision = await resolveReferralGrant({
      code: 'rf 0000-000001',
      newUserId: 'user-new',
      newUserEmail: 'new@example.test',
      now: new Date('2026-09-16T12:00:00.000Z'),
    });
    expect(decision).toEqual({
      ok: true,
      grant: {
        planId: 'garden',
        endsAt: '2026-10-16T12:00:00.000Z',
        referrerUserId: 'user-referrer',
        referrerHouseholdId: 'hh-referrer',
        referralCode: 'RF0000000001',
      },
    });
  });

  // --- The anti-abuse guard, exercised through the policy function. ---
  it('refuses a code redeemed by the SAME account it belongs to', async () => {
    vi.mocked(referralCodes.findReferralCodeOwner).mockResolvedValue(OWNER);
    const decision = await resolveReferralGrant({
      code: 'RF0000000001',
      newUserId: 'user-referrer', // same account as the code owner
      newUserEmail: 'someone-else@example.test',
    });
    expect(decision).toEqual({ ok: false, reason: 'self_referral' });
  });

  it('refuses a code where the new signup email is a +tag alias of the referrer', async () => {
    vi.mocked(referralCodes.findReferralCodeOwner).mockResolvedValue(OWNER);
    const decision = await resolveReferralGrant({
      code: 'RF0000000001',
      newUserId: 'user-new',
      newUserEmail: 'referrer+newaccount@gmail.com',
    });
    expect(decision).toEqual({ ok: false, reason: 'same_email' });
  });

  it('refuses a code shared across two accounts on the same PRIVATE domain', async () => {
    vi.mocked(referralCodes.findReferralCodeOwner).mockResolvedValue({
      ...OWNER,
      referrerEmail: 'chelsea@chelseakr.com',
    });
    const decision = await resolveReferralGrant({
      code: 'RF0000000001',
      newUserId: 'user-new',
      newUserEmail: 'newuser@chelseakr.com',
    });
    expect(decision).toEqual({ ok: false, reason: 'shared_custom_domain' });
  });

  // --- Negative control: a legitimate different-person referral is NOT refused. ---
  it('does NOT refuse a genuinely different person on a shared free provider', async () => {
    vi.mocked(referralCodes.findReferralCodeOwner).mockResolvedValue({
      ...OWNER,
      referrerEmail: 'alice@gmail.com',
    });
    const decision = await resolveReferralGrant({
      code: 'RF0000000001',
      newUserId: 'user-new',
      newUserEmail: 'bob@gmail.com',
    });
    expect(decision.ok).toBe(true);
  });
});

const GRANT: ReferralGrant = {
  planId: 'garden',
  endsAt: '2026-10-16T12:00:00.000Z',
  referrerUserId: 'user-referrer',
  referrerHouseholdId: 'hh-referrer',
  referralCode: 'RF0000000001',
};

describe('creditReferralAfterSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants the referrer a matching one-month Garden bonus and records the event', async () => {
    // First read: the new household, to confirm its own bonus actually landed.
    vi.mocked(getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'garden',
      giftPlanId: 'garden',
      giftEndsAt: GRANT.endsAt,
    } as never);
    // Second read: the referrer's household, for eligibility.
    vi.mocked(getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' } as never);
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});

    await creditReferralAfterSignup({
      grant: GRANT,
      newHouseholdId: 'hh-new',
      now: new Date('2026-09-16T12:00:00.000Z'),
    });

    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: Record<string, any>;
    };
    expect(update.kind).toBe('Update');
    expect(update.input.Key).toEqual({ PK: 'HOUSEHOLD#hh-referrer', SK: 'METADATA' });
    expect(update.input.ExpressionAttributeValues[':plan']).toBe('garden');
    expect(update.input.ExpressionAttributeValues[':src']).toBe('referral');
    expect(update.input.ExpressionAttributeValues[':endsAt']).toBe('2026-10-16T12:00:00.000Z');

    expect(referralCodes.recordReferralEvent).toHaveBeenCalledWith('user-referrer', {
      referredHouseholdId: 'hh-new',
      signedUpAt: '2026-09-16T12:00:00.000Z',
      referredRewardStatus: 'granted',
      referrerRewardStatus: 'granted',
      referrerSkipReason: undefined,
    });
    expect(audit).toHaveBeenCalledWith(
      'referral.signup_credited',
      expect.objectContaining({ metadata: { referrerRewardStatus: 'granted' } })
    );
  });

  it('skips the referrer grant (but still records the event) when they already have a live subscription', async () => {
    vi.mocked(getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'garden',
      giftPlanId: 'garden',
      giftEndsAt: GRANT.endsAt,
    } as never);
    vi.mocked(getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'garden',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    } as never);

    await creditReferralAfterSignup({ grant: GRANT, newHouseholdId: 'hh-new' });

    expect(dynamodb.send).not.toHaveBeenCalled(); // never attempted the write
    expect(referralCodes.recordReferralEvent).toHaveBeenCalledWith(
      'user-referrer',
      expect.objectContaining({
        referrerRewardStatus: 'skipped',
        referrerSkipReason: 'stripe_subscribed',
      })
    );
  });

  it('does NOT credit the referrer when the new household never actually got its own bonus (lost claim race)', async () => {
    // The new household's row carries no gift fields at all — the rare
    // claim-conflict fallback in householdService.createHousehold ran.
    vi.mocked(getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' } as never);

    await creditReferralAfterSignup({ grant: GRANT, newHouseholdId: 'hh-new' });

    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(referralCodes.recordReferralEvent).not.toHaveBeenCalled();
  });

  it('never throws — a failure crediting the referrer must not surface as a signup error', async () => {
    vi.mocked(getHouseholdSubscription).mockRejectedValueOnce(new Error('dynamo unavailable'));
    await expect(
      creditReferralAfterSignup({ grant: GRANT, newHouseholdId: 'hh-new' })
    ).resolves.toBeUndefined();
  });
});
