/**
 * Durable storage for gift subscriptions (ADR 0028): the gift a paid checkout
 * bought, the code that redeems it, and the buyer's own view of it.
 *
 * Three or four rows per gift, written in ONE transaction so a gift can never exist
 * without its code or its code without its gift:
 *
 *   GIFT#{stripeSessionId} / METADATA          the gift. The Session id is
 *                                              the key, so a redelivered
 *                                              webhook, a retry after a crash,
 *                                              or two concurrent deliveries
 *                                              grant nothing the second time
 *                                              (conditional put), whatever the
 *                                              STRIPE_EVENT# ledger says.
 *   GIFTCODE#{hash} / METADATA                 the lookup: hash → Session id.
 *                                              The row never carries the code.
 *   GIFTPAYMENT#{paymentIntentId} / METADATA   the refund lookup: PaymentIntent
 *                                              → Session id, so `charge.refunded`
 *                                              (which names only the PaymentIntent)
 *                                              can find the gift to void. Absent
 *                                              when the event carried no
 *                                              PaymentIntent.
 *   USER#{buyerUserId} / GIFT#{stripeSessionId} the buyer's copy, with the
 *                                              code in plain text. It lives in
 *                                              the buyer's own partition, is
 *                                              shown only to that account, and
 *                                              is deleted with the account
 *                                              (`accountCleanup.deleteUserScopedData`).
 *
 * Redeeming is one more transaction: the gift row takes `redeemedAt` under a
 * condition that it has none yet and was not voided by a refund, and the
 * redeeming household's METADATA row takes `giftPlanId` / `giftEndsAt` under
 * a condition that no gift is running and no live Stripe subscription is on
 * file. Either condition failing cancels both writes, so a code is never
 * consumed without the household receiving the gift, and a household never
 * receives a gift from a code that was already spent.
 *
 * Nothing here imports `billing.ts`: the webhook (`applyStripeEvent`) calls
 * `grantGiftPurchase`, and a module the webhook imports must not import the
 * webhook. The policy that decides WHETHER a household may redeem lives in
 * `giftSubscriptions.ts`, beside checkout.
 *
 * The code is never logged. Log lines carry the Session id, which is the
 * gift's stable, non-secret name everywhere else (Stripe's dashboard, the
 * audit log, the buyer's list).
 */
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import {
  formatGiftCode,
  generateGiftCode,
  hashGiftCode,
  isGiftablePlanId,
  type GiftCode,
  type GiftPurchaseGrant,
  type GiftablePlanId,
} from '../models/giftSubscriptions.js';

const GIFT_PK = (stripeSessionId: string) => `GIFT#${stripeSessionId}`;
const CODE_PK = (codeHash: string) => `GIFTCODE#${codeHash}`;
const PAYMENT_PK = (paymentIntentId: string) => `GIFTPAYMENT#${paymentIntentId}`;
const BUYER_SK_PREFIX = 'GIFT#';

/** The gift row, as read back. `redeemedAt` and friends are absent until redemption. */
export interface GiftRecord {
  stripeSessionId: string;
  planId: GiftablePlanId;
  months: number;
  buyerUserId: string;
  codeHash: string;
  purchasedAt: string;
  /** The PaymentIntent the gift was paid with; absent on a gift granted without one. */
  paymentIntentId?: string;
  redeemedAt?: string;
  redeemedHouseholdId?: string;
  giftEndsAt?: string;
  /** Set when the payment was fully refunded before redemption: the code no longer works. */
  voidedAt?: string;
}

function transactCancellationReasons(err: unknown): Array<{ Code?: string }> {
  if (err instanceof Error && err.name === 'TransactionCanceledException') {
    return (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  }
  return [];
}

/**
 * Create the gift a paid checkout bought, with a freshly generated code.
 * Returns `true` when the gift was created and `false` when a gift for this
 * Session already existed — the second delivery of the same event creates
 * nothing and mints no second code. Any other failure propagates so the
 * webhook answers 5xx and Stripe retries.
 */
export async function grantGiftPurchase(grant: GiftPurchaseGrant): Promise<boolean> {
  const purchased = new Date(grant.purchasedAt);
  if (Number.isNaN(purchased.getTime())) {
    throw new Error('Refusing to grant a gift with an invalid purchase time');
  }
  const code = generateGiftCode();
  const codeHash = hashGiftCode(code);
  // No redeem-by date: a gift code never expires (owner decision B1).
  const paymentLookup = grant.paymentIntentId
    ? [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: PAYMENT_PK(grant.paymentIntentId),
              SK: 'METADATA',
              entityType: 'GiftPayment',
              stripeSessionId: grant.stripeSessionId,
            },
          },
        },
      ]
    : [];
  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: GIFT_PK(grant.stripeSessionId),
                SK: 'METADATA',
                entityType: 'GiftSubscription',
                stripeSessionId: grant.stripeSessionId,
                planId: grant.planId,
                months: grant.months,
                buyerUserId: grant.buyerUserId,
                codeHash,
                purchasedAt: purchased.toISOString(),
                ...(grant.paymentIntentId ? { paymentIntentId: grant.paymentIntentId } : {}),
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: CODE_PK(codeHash),
                SK: 'METADATA',
                entityType: 'GiftCode',
                stripeSessionId: grant.stripeSessionId,
              },
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: `USER#${grant.buyerUserId}`,
                SK: `${BUYER_SK_PREFIX}${grant.stripeSessionId}`,
                entityType: 'GiftPurchase',
                stripeSessionId: grant.stripeSessionId,
                code,
                planId: grant.planId,
                months: grant.months,
                purchasedAt: purchased.toISOString(),
              },
            },
          },
          ...paymentLookup,
        ],
      })
    );
    return true;
  } catch (err) {
    if (transactCancellationReasons(err)[0]?.Code === 'ConditionalCheckFailed') {
      return false;
    }
    throw err;
  }
}

function toGiftRecord(item: Record<string, unknown> | undefined): GiftRecord | null {
  if (!item) return null;
  if (
    typeof item.stripeSessionId !== 'string' ||
    !isGiftablePlanId(item.planId) ||
    typeof item.months !== 'number' ||
    typeof item.buyerUserId !== 'string' ||
    typeof item.codeHash !== 'string' ||
    typeof item.purchasedAt !== 'string'
  ) {
    return null;
  }
  return {
    stripeSessionId: item.stripeSessionId,
    planId: item.planId,
    months: item.months,
    buyerUserId: item.buyerUserId,
    codeHash: item.codeHash,
    purchasedAt: item.purchasedAt,
    paymentIntentId: typeof item.paymentIntentId === 'string' ? item.paymentIntentId : undefined,
    redeemedAt: typeof item.redeemedAt === 'string' ? item.redeemedAt : undefined,
    redeemedHouseholdId:
      typeof item.redeemedHouseholdId === 'string' ? item.redeemedHouseholdId : undefined,
    giftEndsAt: typeof item.giftEndsAt === 'string' ? item.giftEndsAt : undefined,
    voidedAt: typeof item.voidedAt === 'string' ? item.voidedAt : undefined,
  };
}

async function getGift(stripeSessionId: string): Promise<GiftRecord | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: GIFT_PK(stripeSessionId), SK: 'METADATA' } })
  );
  return toGiftRecord(result.Item);
}

/**
 * The gift a canonical code names, or null when no such gift exists. A row
 * whose recorded hash does not match the code is treated as no gift at all:
 * the lookup and the gift are written together, so a mismatch is a defect,
 * and a defect must not redeem.
 */
export async function findGiftByCode(code: GiftCode): Promise<GiftRecord | null> {
  const codeHash = hashGiftCode(code);
  const lookup = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: CODE_PK(codeHash), SK: 'METADATA' } })
  );
  const stripeSessionId: unknown = lookup.Item?.stripeSessionId;
  if (typeof stripeSessionId !== 'string' || stripeSessionId === '') return null;
  const gift = await getGift(stripeSessionId);
  if (!gift || gift.codeHash !== codeHash) return null;
  return gift;
}

export type RedeemWriteOutcome = 'redeemed' | 'code_conflict' | 'household_conflict';

/**
 * Consume a gift and place it on a household, atomically. The caller has
 * already decided the household MAY redeem (`giftSubscriptions.redeemGiftCode`);
 * the conditions here re-check both halves at write time, so a code spent by
 * a concurrent request, or a subscription that landed between the read and
 * this write, cancels the whole transaction rather than half of it.
 *
 * `liveSubscriptionStatuses` is the set `createCheckoutSession` treats as
 * "already subscribed"; it is passed in rather than imported so this module
 * stays free of `billing.ts`.
 */
export async function redeemGift(args: {
  gift: GiftRecord;
  householdId: string;
  endsAt: Date;
  now: Date;
  liveSubscriptionStatuses: readonly string[];
}): Promise<RedeemWriteOutcome> {
  const { gift, householdId, endsAt, now, liveSubscriptionStatuses } = args;
  const nowIso = now.toISOString();
  const endsAtIso = endsAt.toISOString();
  const statusNames: Record<string, string> = {};
  const statusValues: Record<string, string> = {};
  liveSubscriptionStatuses.forEach((status, i) => {
    statusValues[`:live${i}`] = status;
  });
  const liveList = Object.keys(statusValues).join(', ');
  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: GIFT_PK(gift.stripeSessionId), SK: 'METADATA' },
              UpdateExpression:
                'SET redeemedAt = :now, redeemedHouseholdId = :hh, giftEndsAt = :endsAt',
              // No redeem-by clause: codes never expire (decision B1). A
              // refund that landed between the read and this write voids the
              // code, and the void wins.
              ConditionExpression:
                'attribute_exists(PK) AND attribute_not_exists(redeemedAt) AND attribute_not_exists(voidedAt) AND codeHash = :hash',
              ExpressionAttributeValues: {
                ':now': nowIso,
                ':hh': householdId,
                ':endsAt': endsAtIso,
                ':hash': gift.codeHash,
              },
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
              UpdateExpression:
                'SET giftPlanId = :plan, giftEndsAt = :endsAt, giftStripeSessionId = :sid, ' +
                'giftRedeemedAt = :now, giftSource = :src',
              // `giftEndsAt` is compared as a string: every value written is
              // `Date#toISOString()`, a fixed-width UTC form whose lexical
              // order is its chronological order. The subscription clause is
              // the negation of "has a live subscription" as
              // `createCheckoutSession` defines it: no id on file, or a
              // status that is recorded and not live.
              ConditionExpression:
                'attribute_exists(PK) AND (attribute_not_exists(giftEndsAt) OR giftEndsAt < :now) AND ' +
                `(attribute_not_exists(stripeSubscriptionId) OR (attribute_exists(subscriptionStatus) AND NOT (subscriptionStatus IN (${liveList}))))`,
              ExpressionAttributeNames:
                Object.keys(statusNames).length > 0 ? statusNames : undefined,
              ExpressionAttributeValues: {
                ':plan': gift.planId,
                ':endsAt': endsAtIso,
                ':sid': gift.stripeSessionId,
                ':now': nowIso,
                // Explicit, not just the default absent-means-purchase
                // reading (services/billing.ts): a household's SECOND gift
                // (this purchase, redeemed after an earlier referral bonus
                // ended) must not keep showing 'referral' in GET /billing/me
                // once a real purchase is what is actually running.
                ':src': 'purchase',
                ...statusValues,
              },
            },
          },
        ],
      })
    );
    return 'redeemed';
  } catch (err) {
    const reasons = transactCancellationReasons(err);
    if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'code_conflict';
    if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'household_conflict';
    logger.error(
      { err: (err as Error).message, stripeSessionId: gift.stripeSessionId, householdId },
      'gift_redeem_write_failed'
    );
    throw err;
  }
}

export type GiftPurchaseStatus = 'unredeemed' | 'redeemed' | 'voided' | 'unknown';

/** One gift the buyer bought, as their own account sees it. The code is included. */
export interface GiftPurchaseView {
  stripeSessionId: string;
  /** Display form, `FG-XXXX-XXXX-XXXX-XXXX`. */
  code: string;
  planId: GiftablePlanId;
  months: number;
  purchasedAt: string;
  /** `unknown` when the gift row could not be read: the code is still shown,
   *  and its status is not guessed. */
  status: GiftPurchaseStatus;
  redeemedAt: string | null;
  giftEndsAt: string | null;
}

/**
 * The gift row for a listing, in three settled states (ADR 0010): the record,
 * `null` when no such row exists, or `'unavailable'` when the read FAILED. The
 * third is a value of its own so the caller cannot mistake a DynamoDB blip
 * for "not redeemed": the listing carries it as `status: 'unknown'`.
 */
async function readGiftForListing(
  stripeSessionId: string
): Promise<GiftRecord | null | 'unavailable'> {
  try {
    return await getGift(stripeSessionId);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, stripeSessionId },
      'gift_purchase_status_read_failed'
    );
    return 'unavailable';
  }
}

/**
 * Every gift this account has bought, newest first. Throws on a failed read of
 * the buyer's own rows — the caller decides how to say "unavailable" — and
 * marks an individual gift `unknown` when its gift row could not be read.
 */
export async function listGiftPurchases(buyerUserId: string): Promise<GiftPurchaseView[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${buyerUserId}`, ':sk': BUYER_SK_PREFIX },
    })
  );
  const rows = (result.Items ?? []) as Array<Record<string, unknown>>;
  const views: GiftPurchaseView[] = [];
  for (const row of rows) {
    if (
      typeof row.stripeSessionId !== 'string' ||
      typeof row.code !== 'string' ||
      !isGiftablePlanId(row.planId) ||
      typeof row.months !== 'number' ||
      typeof row.purchasedAt !== 'string'
    ) {
      continue;
    }
    const gift = await readGiftForListing(row.stripeSessionId);
    // A failed read and a missing row both publish `unknown`: neither is
    // evidence about redemption, and the dates that go with a known status
    // are withheld rather than defaulted.
    const known = gift !== 'unavailable' && gift !== null ? gift : null;
    const status: GiftPurchaseStatus =
      known === null
        ? 'unknown'
        : known.redeemedAt
          ? 'redeemed'
          : known.voidedAt
            ? 'voided'
            : 'unredeemed';
    const redeemedAt = known?.redeemedAt ?? null;
    const giftEndsAt = known?.giftEndsAt ?? null;
    views.push({
      stripeSessionId: row.stripeSessionId,
      code: formatGiftCode(row.code),
      planId: row.planId,
      months: row.months,
      purchasedAt: row.purchasedAt,
      status,
      redeemedAt,
      giftEndsAt,
    });
  }
  return views.sort((a, b) =>
    a.purchasedAt < b.purchasedAt ? 1 : a.purchasedAt > b.purchasedAt ? -1 : 0
  );
}

export type GiftVoidOutcome =
  /** The code no longer works. */
  | 'voided'
  /** Already voided by an earlier delivery of this or another refund event. */
  | 'already_voided'
  /** The gift was redeemed before the refund. The household keeps it; an operator decides. */
  | 'already_redeemed'
  /** The PaymentIntent paid for no gift (a plan, a pack), or the gift row is gone. */
  | 'not_a_gift';

/**
 * Void the gift a refunded PaymentIntent paid for (owner decision E1).
 *
 * The code stops working: the gift row takes `voidedAt` under a condition
 * that it is unredeemed and not voided yet, and `redeemGift` refuses a voided
 * gift. A redeemed gift is NOT taken back from the household here: the Terms
 * handle a refund of a redeemed gift case by case, so the webhook reports it
 * and leaves the household's plan alone. Idempotent: a redelivered event finds
 * the gift already voided and changes nothing.
 */
export async function voidGiftForRefund(args: {
  paymentIntentId: string;
  now: Date;
}): Promise<{ outcome: GiftVoidOutcome; stripeSessionId: string | null }> {
  const lookup = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: PAYMENT_PK(args.paymentIntentId), SK: 'METADATA' },
    })
  );
  const stripeSessionId: unknown = lookup.Item?.stripeSessionId;
  if (typeof stripeSessionId !== 'string' || stripeSessionId === '') {
    return { outcome: 'not_a_gift', stripeSessionId: null };
  }
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: GIFT_PK(stripeSessionId), SK: 'METADATA' },
        UpdateExpression: 'SET voidedAt = :now, voidReason = :reason',
        ConditionExpression:
          'attribute_exists(PK) AND attribute_not_exists(redeemedAt) AND attribute_not_exists(voidedAt)',
        ExpressionAttributeValues: { ':now': args.now.toISOString(), ':reason': 'refunded' },
      })
    );
    return { outcome: 'voided', stripeSessionId };
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'ConditionalCheckFailedException') throw err;
  }
  // The condition failed: say which way, from the row itself.
  const gift = await getGift(stripeSessionId);
  if (!gift) return { outcome: 'not_a_gift', stripeSessionId };
  if (gift.redeemedAt) return { outcome: 'already_redeemed', stripeSessionId };
  return { outcome: 'already_voided', stripeSessionId };
}
