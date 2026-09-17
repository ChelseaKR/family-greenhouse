/**
 * Durable storage for referral codes and the events they produce (ADR 0029).
 *
 * Three row shapes, mirroring `giftCodes.ts`'s split between a code, its
 * owner's own copy, and a lookup:
 *
 *   USER#{userId} / REFERRAL_CODE            the referrer's own code, get-or-
 *                                             create so a user has exactly
 *                                             one for life. `householdId` is
 *                                             a SNAPSHOT of whichever
 *                                             household was active the first
 *                                             time the code was generated —
 *                                             the referral bonus always lands
 *                                             there, even if the user later
 *                                             switches households.
 *   REFERRALCODE#{code} / METADATA            the lookup: code -> owner. Not
 *                                             hashed (unlike gift codes): a
 *                                             referral code is meant to be
 *                                             shared publicly, and holding
 *                                             one benefits the REFERRER, not
 *                                             whoever redeems it, so there is
 *                                             no bearer-payment secrecy to
 *                                             protect (see models/referrals.ts).
 *   USER#{referrerUserId} / REFERRAL#{householdId}   one row per successful
 *                                             referral, written after the new
 *                                             household exists, recording
 *                                             whether each side's incentive
 *                                             was granted. This is what the
 *                                             "Refer a friend" settings panel
 *                                             reads to show status.
 *
 * Nothing here imports `billing.ts` or reaches Stripe: this module is pure
 * persistence, exactly like `giftCodes.ts`. The eligibility policy — the
 * anti-self-referral guard and the referrer's live-subscription/active-gift
 * checks — lives in `services/referrals.ts`, beside it.
 */
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { generateReferralCode, type ReferralCode } from '../models/referrals.js';

const CODE_LOOKUP_PK = (code: ReferralCode) => `REFERRALCODE#${code}`;
const USER_CODE_SK = 'REFERRAL_CODE';
const REFERRAL_EVENT_SK = (householdId: string) => `REFERRAL#${householdId}`;
const REFERRAL_EVENT_SK_PREFIX = 'REFERRAL#';

function transactCancellationReasons(err: unknown): Array<{ Code?: string }> {
  if (err instanceof Error && err.name === 'TransactionCanceledException') {
    return (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  }
  return [];
}

export interface ReferralCodeOwner {
  code: ReferralCode;
  referrerUserId: string;
  referrerHouseholdId: string;
  referrerEmail: string;
  createdAt: string;
}

/**
 * The caller's own referral code, minting one on first request. Idempotent:
 * a second call for the same user always returns the same code, even if two
 * requests race (the loser of the code-creation race re-reads and returns
 * the winner's code rather than erroring).
 */
export async function getOrCreateReferralCode(args: {
  userId: string;
  householdId: string;
  email: string;
  now?: Date;
}): Promise<ReferralCodeOwner> {
  const now = (args.now ?? new Date()).toISOString();
  const existing = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USER#${args.userId}`, SK: USER_CODE_SK } })
  );
  if (
    existing.Item &&
    typeof existing.Item.code === 'string' &&
    typeof existing.Item.householdId === 'string' &&
    typeof existing.Item.createdAt === 'string'
  ) {
    return {
      code: existing.Item.code,
      referrerUserId: args.userId,
      referrerHouseholdId: existing.Item.householdId,
      referrerEmail: typeof existing.Item.email === 'string' ? existing.Item.email : args.email,
      createdAt: existing.Item.createdAt,
    };
  }

  const referrerEmail = args.email.toLowerCase();
  // Bounded retry against a code collision (astronomically unlikely at 50
  // bits, but cheap to handle rather than assume away).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    try {
      await dynamodb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE_NAME,
                Item: {
                  PK: CODE_LOOKUP_PK(code),
                  SK: 'METADATA',
                  entityType: 'ReferralCodeLookup',
                  code,
                  referrerUserId: args.userId,
                  referrerHouseholdId: args.householdId,
                  referrerEmail,
                  createdAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: TABLE_NAME,
                Item: {
                  PK: `USER#${args.userId}`,
                  SK: USER_CODE_SK,
                  entityType: 'ReferralCodeOwner',
                  code,
                  householdId: args.householdId,
                  email: referrerEmail,
                  createdAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        })
      );
      return {
        code,
        referrerUserId: args.userId,
        referrerHouseholdId: args.householdId,
        referrerEmail,
        createdAt: now,
      };
    } catch (err) {
      const reasons = transactCancellationReasons(err);
      if (reasons[1]?.Code === 'ConditionalCheckFailed') {
        // Lost a race with a concurrent call for the SAME account: someone
        // else's request already minted this user's code. Re-read and hand
        // back the winner's, rather than erroring or minting a second one.
        const winner = await dynamodb.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: { PK: `USER#${args.userId}`, SK: USER_CODE_SK },
          })
        );
        if (
          winner.Item &&
          typeof winner.Item.code === 'string' &&
          typeof winner.Item.householdId === 'string' &&
          typeof winner.Item.createdAt === 'string'
        ) {
          return {
            code: winner.Item.code,
            referrerUserId: args.userId,
            referrerHouseholdId: winner.Item.householdId,
            referrerEmail:
              typeof winner.Item.email === 'string' ? winner.Item.email : referrerEmail,
            createdAt: winner.Item.createdAt,
          };
        }
        throw err;
      }
      if (reasons[0]?.Code === 'ConditionalCheckFailed') continue; // code taken; retry with a new one
      throw err;
    }
  }
  throw new Error('referral_code_generation_failed: exhausted retries');
}

/** The code's owner, or null when no such code exists. Not hashed — see the
 *  module doc for why that is fine here. */
export async function findReferralCodeOwner(code: ReferralCode): Promise<ReferralCodeOwner | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: CODE_LOOKUP_PK(code), SK: 'METADATA' } })
  );
  const item = result.Item;
  if (
    !item ||
    typeof item.referrerUserId !== 'string' ||
    typeof item.referrerHouseholdId !== 'string' ||
    typeof item.referrerEmail !== 'string' ||
    typeof item.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    code,
    referrerUserId: item.referrerUserId,
    referrerHouseholdId: item.referrerHouseholdId,
    referrerEmail: item.referrerEmail,
    createdAt: item.createdAt,
  };
}

export type ReferrerRewardStatus = 'granted' | 'skipped';

export interface ReferralEvent {
  referredHouseholdId: string;
  signedUpAt: string;
  /** The new household's own bonus — always 'granted' when this row exists;
   *  a referral that did not grant the new side is never recorded at all
   *  (see `services/referrals.ts`). */
  referredRewardStatus: 'granted';
  referrerRewardStatus: ReferrerRewardStatus;
  /** Present only when `referrerRewardStatus` is 'skipped' — a short, stable
   *  token for the settings UI's copy, never a raw error message. */
  referrerSkipReason?: string;
}

/**
 * Record one successful referral against the referrer's own list. Conditional
 * on not already existing, keyed by the NEW household's id — idempotent
 * against a retried request describing the same signup.
 */
export async function recordReferralEvent(
  referrerUserId: string,
  event: ReferralEvent
): Promise<void> {
  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: `USER#${referrerUserId}`,
                SK: REFERRAL_EVENT_SK(event.referredHouseholdId),
                entityType: 'ReferralEvent',
                referrerUserId,
                ...event,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      })
    );
  } catch (err) {
    if (transactCancellationReasons(err)[0]?.Code === 'ConditionalCheckFailed') return; // already recorded
    throw err;
  }
}

/** Every referral this account has produced, newest first. */
export async function listReferralEvents(referrerUserId: string): Promise<ReferralEvent[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${referrerUserId}`,
        ':sk': REFERRAL_EVENT_SK_PREFIX,
      },
    })
  );
  const rows = (result.Items ?? []) as Array<Record<string, unknown>>;
  const events: ReferralEvent[] = [];
  for (const row of rows) {
    if (
      typeof row.referredHouseholdId !== 'string' ||
      typeof row.signedUpAt !== 'string' ||
      row.referredRewardStatus !== 'granted' ||
      (row.referrerRewardStatus !== 'granted' && row.referrerRewardStatus !== 'skipped')
    ) {
      continue;
    }
    events.push({
      referredHouseholdId: row.referredHouseholdId,
      signedUpAt: row.signedUpAt,
      referredRewardStatus: 'granted',
      referrerRewardStatus: row.referrerRewardStatus,
      referrerSkipReason:
        typeof row.referrerSkipReason === 'string' ? row.referrerSkipReason : undefined,
    });
  }
  return events.sort((a, b) =>
    a.signedUpAt < b.signedUpAt ? 1 : a.signedUpAt > b.signedUpAt ? -1 : 0
  );
}
