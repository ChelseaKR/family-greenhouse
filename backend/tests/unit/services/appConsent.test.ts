/**
 * A parent's withdrawn consent (services/appConsent.ts): the app registers
 * its signed app transaction, Apple's RESCIND_CONSENT names that app
 * transaction, and the account it reaches loses every household. Signed
 * through a throwaway chain, against a small in-memory DynamoDB.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));

const table = vi.hoisted(() => new Map<string, Record<string, any>>());
vi.mock('../../../src/utils/dynamodb.js', () => {
  const key = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
  const conditionFailed = () =>
    Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
  return {
    TABLE_NAME: 'test-table',
    dynamodb: {
      send: vi.fn(async (cmd: { kind: string; input: Record<string, any> }) => {
        const { input } = cmd;
        if (cmd.kind === 'Get') return { Item: table.get(key(input.Key)) };
        if (cmd.kind === 'Put') {
          table.set(key(input.Item), { ...input.Item });
          return {};
        }
        if (cmd.kind === 'Delete') {
          table.delete(key(input.Key));
          return {};
        }
        if (cmd.kind === 'Query') {
          const pk = input.ExpressionAttributeValues[':pk'];
          const sk = input.ExpressionAttributeValues[':sk'];
          const [pkAttr, skAttr] = input.IndexName === 'GSI1' ? ['GSI1PK', 'GSI1SK'] : ['PK', 'SK'];
          const Items = [...table.values()].filter(
            (r) => r[pkAttr] === pk && String(r[skAttr]).startsWith(sk)
          );
          return { Items };
        }
        if (cmd.kind === 'Update') {
          const row = table.get(key(input.Key));
          if (input.ConditionExpression === 'attribute_exists(PK)' && !row) throw conditionFailed();
          if (input.UpdateExpression === 'SET appConsentRevokedAt = :r') {
            row!.appConsentRevokedAt = input.ExpressionAttributeValues[':r'];
            return {};
          }
          if (input.UpdateExpression === 'REMOVE appConsentRevokedAt') {
            delete row!.appConsentRevokedAt;
            return {};
          }
          throw new Error(`unexpected update ${input.UpdateExpression}`);
        }
        throw new Error(`unexpected command ${cmd.kind}`);
      }),
    },
  };
});

vi.mock('../../../src/services/householdService.js', () => ({
  getMembershipsByUser: vi.fn(async (userId: string) =>
    [...table.values()]
      .filter((r) => r.SK === `MEMBER#${userId}`)
      .map((r) => ({ householdId: r.householdId, role: r.role, name: '', joinedAt: '' }))
  ),
}));

import {
  applyRescindConsent,
  isAppConsentRevoked,
  registerAppTransaction,
  restoreAppConsent,
} from '../../../src/services/appConsent.js';
import {
  applyConsentNotification,
  applyNotification,
} from '../../../src/services/appStoreBilling.js';
import { AppStoreVerificationError } from '../../../src/services/appStoreJws.js';
import { makeChain, signJws, type ChainFixture } from '../../support/appleJwsFixture.js';

const BUNDLE = 'net.familygreenhouse.app';

function member(householdId: string, userId: string) {
  table.set(`HOUSEHOLD#${householdId}|MEMBER#${userId}`, {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `MEMBER#${userId}`,
    householdId,
    userId,
    role: 'member',
  });
}
const memberRow = (h: string, u: string) => table.get(`HOUSEHOLD#${h}|MEMBER#${u}`)!;

describe('app consent', () => {
  let chain: ChainFixture;
  let other: ChainFixture;
  let opts: { trustedRootsPem: string[] };
  beforeAll(() => {
    chain = makeChain();
    other = makeChain();
    opts = { trustedRootsPem: [chain.rootPem] };
  }, 30_000);

  beforeEach(() => {
    table.clear();
  });

  const appTx = (appTransactionId: string, bundleId = BUNDLE, c?: ChainFixture) =>
    signJws(c ?? chain, { bundleId, appTransactionId, receiptType: 'Production' });

  const rescind = (signedAppTransactionInfo?: string, bundleId = BUNDLE) =>
    signJws(chain, {
      notificationType: 'RESCIND_CONSENT',
      signedDate: Date.now(),
      appData: { bundleId, environment: 'Sandbox', signedAppTransactionInfo },
    });

  it('withdraws every household of the account that registered the app transaction', async () => {
    member('hh-1', 'kid');
    member('hh-2', 'kid');
    member('hh-1', 'parent');
    await registerAppTransaction('kid', appTx('apptx-1'), opts);

    const result = await applyNotification(rescind(appTx('apptx-1')), opts);
    expect(result).toMatchObject({ outcome: 'applied', notificationType: 'RESCIND_CONSENT' });
    expect(memberRow('hh-1', 'kid').appConsentRevokedAt).toEqual(expect.any(String));
    expect(memberRow('hh-2', 'kid').appConsentRevokedAt).toEqual(expect.any(String));
    expect(memberRow('hh-1', 'parent').appConsentRevokedAt).toBeUndefined();
    expect(await isAppConsentRevoked('kid')).toBe(true);
    expect(await isAppConsentRevoked('parent')).toBe(false);
  });

  it('is handled, and reaches nobody, when no account registered that app transaction', async () => {
    member('hh-1', 'adult');
    const result = await applyRescindConsent(
      { bundleId: BUNDLE, signedAppTransactionInfo: appTx('apptx-unknown') },
      opts
    );
    expect(result).toEqual({ outcome: 'unmatched', accounts: 0 });
    expect(memberRow('hh-1', 'adult').appConsentRevokedAt).toBeUndefined();
  });

  it('refuses another app, in the notification or in the app transaction', async () => {
    member('hh-1', 'kid');
    await registerAppTransaction('kid', appTx('apptx-1'), opts);
    expect(
      await applyRescindConsent(
        { bundleId: 'com.other', signedAppTransactionInfo: appTx('apptx-1') },
        opts
      )
    ).toEqual({ outcome: 'wrong_app', accounts: 0 });
    expect(
      await applyRescindConsent(
        { bundleId: BUNDLE, signedAppTransactionInfo: appTx('apptx-1', 'com.other') },
        opts
      )
    ).toEqual({ outcome: 'wrong_app', accounts: 0 });
    expect(await isAppConsentRevoked('kid')).toBe(false);
  });

  it('refuses an app transaction not signed through the trusted chain', async () => {
    await expect(
      registerAppTransaction('kid', appTx('apptx-1', BUNDLE, other), opts)
    ).rejects.toBeInstanceOf(AppStoreVerificationError);
    await expect(
      applyRescindConsent(
        { bundleId: BUNDLE, signedAppTransactionInfo: appTx('apptx-1', BUNDLE, other) },
        opts
      )
    ).rejects.toBeInstanceOf(AppStoreVerificationError);
    await expect(applyRescindConsent({ bundleId: BUNDLE }, opts)).rejects.toBeInstanceOf(
      AppStoreVerificationError
    );
  });

  it('refuses a registration without an appTransactionId', async () => {
    const jws = signJws(chain, { bundleId: BUNDLE });
    await expect(registerAppTransaction('kid', jws, opts)).rejects.toThrow(/appTransactionId/);
  });

  it('keeps the link in the account partition, so account deletion removes it', async () => {
    await registerAppTransaction('kid', appTx('apptx-1'), opts);
    expect(table.get('USER#kid|APP_TXN#apptx-1')).toMatchObject({
      GSI1PK: 'APP_TXN#apptx-1',
      GSI1SK: 'USER#kid',
      userId: 'kid',
    });
  });

  it('a missing consent row is not a withdrawal', async () => {
    expect(await isAppConsentRevoked('nobody')).toBe(false);
  });

  it('support can restore access', async () => {
    member('hh-1', 'kid');
    await registerAppTransaction('kid', appTx('apptx-1'), opts);
    await applyRescindConsent(
      { bundleId: BUNDLE, signedAppTransactionInfo: appTx('apptx-1') },
      opts
    );
    await restoreAppConsent('kid');
    expect(await isAppConsentRevoked('kid')).toBe(false);
    expect(memberRow('hh-1', 'kid').appConsentRevokedAt).toBeUndefined();
  });

  it('only RESCIND_CONSENT is handled while purchases are off', async () => {
    member('hh-1', 'kid');
    await registerAppTransaction('kid', appTx('apptx-1'), opts);
    const subscribed = signJws(chain, {
      notificationType: 'SUBSCRIBED',
      signedDate: Date.now(),
      data: { bundleId: BUNDLE },
    });
    expect(await applyConsentNotification(subscribed, opts)).toBeNull();
    const result = await applyConsentNotification(rescind(appTx('apptx-1')), opts);
    expect(result).toMatchObject({ outcome: 'applied', notificationType: 'RESCIND_CONSENT' });
    expect(await isAppConsentRevoked('kid')).toBe(true);
  });
});
