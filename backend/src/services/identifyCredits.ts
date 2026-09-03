/**
 * Durable per-household identification credits — the balance an
 * identification top-up pack buys (`models/identifyTopUp.ts`).
 *
 * Storage: one row PER PACK in the household partition, keyed by the Stripe
 * Checkout Session that paid for it:
 *
 *   PK: HOUSEHOLD#{householdId}
 *   SK: IDCREDIT#{stripeSessionId}
 *   granted:        number   credits the pack was sold with
 *   remaining:      number   credits left (atomic conditional decrement)
 *   purchasedAt:    ISO      payment completed
 *   expiresAt:      ISO      purchasedAt + validityDays — informational
 *   expiresAtEpoch: number   the same instant, for condition expressions
 *   ttl:            number   expiresAtEpoch + 30 days grace, table sweeps it
 *
 * Why a row per pack and not a counter on METADATA:
 *   - The session id in the key makes a grant idempotent by construction: a
 *     conditional put either creates the pack or reports it already exists.
 *     A redelivered webhook, a retried apply, two concurrent deliveries — none
 *     can grant twice, whatever the dedupe ledger says.
 *   - Each pack keeps its own 12-month expiry, so a second purchase never
 *     revives credits from an earlier, expired one.
 *   - The METADATA row carries the `lastStripeEventCreated` ordering guard
 *     for subscription events; credit writes must not contend with it.
 *
 * Consumption draws from the pack expiring SOONEST, one credit at a time, via
 * a conditional update, so concurrent identifications cannot overspend a
 * pack any more than they can overspend the monthly allowance
 * (`identifyBudget.reserveUsage`).
 *
 * Reads: a missing pack list is a real zero. A FAILED read is `null` — we do
 * not know — and is never published as 0 (ADR 0010).
 */
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

const SK_PREFIX = 'IDCREDIT#';
const TTL_GRACE_SECONDS = 30 * 24 * 60 * 60;

export class IdentifyCreditsExhaustedError extends Error {
  constructor() {
    super('No identification credits remaining');
    this.name = 'IdentifyCreditsExhaustedError';
  }
}

export interface IdentifyCreditBalance {
  /** Credits left across every unexpired pack. A genuine 0 is 0. */
  remaining: number;
  /** When the soonest-expiring pack that still has credits runs out, or
   *  null when no credits remain. ISO string. */
  expiresAt: string | null;
}

interface CreditPackRow {
  PK: string;
  SK: string;
  remaining: number;
  expiresAt: string;
  expiresAtEpoch: number;
}

function packKey(householdId: string, stripeSessionId: string): { PK: string; SK: string } {
  return { PK: `HOUSEHOLD#${householdId}`, SK: `${SK_PREFIX}${stripeSessionId}` };
}

/**
 * Create the pack a paid checkout bought. Returns `true` when the pack was
 * created and `false` when a pack for this session already existed — the
 * second delivery of the same event grants nothing. Any other failure
 * propagates so the webhook answers 5xx and Stripe retries.
 */
export async function grantCreditPack(grant: {
  householdId: string;
  stripeSessionId: string;
  credits: number;
  purchasedAt: string;
  validityDays: number;
}): Promise<boolean> {
  if (!Number.isInteger(grant.credits) || grant.credits <= 0) {
    throw new Error(`Refusing to grant a non-positive credit pack (${grant.credits})`);
  }
  const purchased = new Date(grant.purchasedAt);
  if (Number.isNaN(purchased.getTime())) {
    throw new Error(`Refusing to grant a credit pack with an invalid purchase time`);
  }
  const expiresAtEpoch = Math.floor(purchased.getTime() / 1000) + grant.validityDays * 24 * 60 * 60;
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...packKey(grant.householdId, grant.stripeSessionId),
          entityType: 'IdentifyCreditPack',
          householdId: grant.householdId,
          stripeSessionId: grant.stripeSessionId,
          granted: grant.credits,
          remaining: grant.credits,
          purchasedAt: purchased.toISOString(),
          expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
          expiresAtEpoch,
          ttl: expiresAtEpoch + TTL_GRACE_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

/**
 * Every pack with credits left that has not expired, soonest expiry first.
 * Throws on a failed read — callers decide whether that is "unknown"
 * (a balance display) or "fail closed" (a reservation before a paid call).
 */
async function listActivePacks(householdId: string, now: Date): Promise<CreditPackRow[]> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}`, ':sk': SK_PREFIX },
    })
  );
  const rows = (result.Items ?? []) as Partial<CreditPackRow>[];
  return rows
    .filter(
      (row): row is CreditPackRow =>
        typeof row.PK === 'string' &&
        typeof row.SK === 'string' &&
        typeof row.remaining === 'number' &&
        row.remaining > 0 &&
        typeof row.expiresAtEpoch === 'number' &&
        row.expiresAtEpoch > nowEpoch &&
        typeof row.expiresAt === 'string'
    )
    .sort((a, b) => a.expiresAtEpoch - b.expiresAtEpoch);
}

function balanceOf(packs: CreditPackRow[]): IdentifyCreditBalance {
  const remaining = packs.reduce((sum, p) => sum + p.remaining, 0);
  return { remaining, expiresAt: remaining > 0 ? packs[0].expiresAt : null };
}

/**
 * The household's current balance, or `null` when it could not be read.
 * `null` is not 0: a DynamoDB blip must not tell a household it has nothing
 * left (and must not tell the identify response that a pack is exhausted).
 */
export async function getCreditBalance(
  householdId: string,
  now: Date = new Date()
): Promise<IdentifyCreditBalance | null> {
  try {
    return balanceOf(await listActivePacks(householdId, now));
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'identify.credits_read_failed');
    return null;
  }
}

/**
 * Spend one credit from the soonest-expiring pack. Returns the balance
 * AFTER the spend. Throws `IdentifyCreditsExhaustedError` when no unexpired
 * pack has a credit left; propagates infrastructure failures so a caller
 * guarding a paid upstream call fails closed rather than sending an
 * unmetered request.
 *
 * The condition re-checks `remaining` and expiry at write time: two
 * concurrent callers can both read a pack with one credit, but only one
 * decrement succeeds; the loser moves to the next pack or is told the packs
 * are exhausted.
 */
export async function consumeCredit(
  householdId: string,
  now: Date = new Date()
): Promise<IdentifyCreditBalance> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const packs = await listActivePacks(householdId, now);
  for (let i = 0; i < packs.length; i += 1) {
    const pack = packs[i];
    try {
      const result = await dynamodb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: pack.PK, SK: pack.SK },
          UpdateExpression: 'SET #remaining = #remaining - :one',
          ConditionExpression: '#remaining > :zero AND #expiresAtEpoch > :now',
          ExpressionAttributeNames: {
            '#remaining': 'remaining',
            '#expiresAtEpoch': 'expiresAtEpoch',
          },
          ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':now': nowEpoch },
          ReturnValues: 'UPDATED_NEW',
        })
      );
      const left: unknown = result.Attributes?.remaining;
      if (typeof left !== 'number') {
        throw new Error('Credit consumption returned no remaining total');
      }
      // Balance after the spend: this pack's new total plus every later pack
      // as read. Informational; the next reservation re-reads.
      const after = [{ ...pack, remaining: left }, ...packs.slice(i + 1)].filter(
        (p) => p.remaining > 0
      );
      return balanceOf(after);
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        // Raced to zero, or expired between the read and the write. Try the
        // next pack; the loop ends in "exhausted" if none is left.
        continue;
      }
      logger.error({ err: (err as Error).message, householdId }, 'identify.credits_consume_failed');
      throw err;
    }
  }
  throw new IdentifyCreditsExhaustedError();
}
