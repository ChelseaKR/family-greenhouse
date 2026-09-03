/**
 * Per-household monthly spend cap for the Bedrock leaf-health check
 * (`POST /plants/{id}/health-check`).
 *
 * Each check is one Bedrock vision invocation (fractions of a cent), already
 * bounded by the 5/min per-user rate limiter — but the rate limiter is
 * in-memory per warm container, so the real ceiling is N containers × max.
 * This adds a hard, durable monthly ceiling per household so concurrency can't
 * cost-amplify Bedrock spend, mirroring the chat token-budget gate and the
 * identify monthly meter.
 *
 * Storage (same single-partition shape as identifyBudget.ts):
 *
 *   PK: LEAFHEALTH#BUDGET
 *   SK: MONTH#{yyyy-mm}#HH#{householdId}
 *   used: number (atomic ADD)
 *   ttl:  ~95 days (same retention as the chat + identify budget rows)
 *
 * Configurable via `LEAF_HEALTH_MONTHLY_CAP` (default 200/household/month).
 * Unlike identify, enforcement is ALWAYS on — leaf-health is a pure Bedrock
 * cost with no per-plan allowance to tier — but a cap of 0 or a negative value
 * disables the gate entirely (treated as "unlimited"), which is the documented
 * escape hatch if a household legitimately needs more.
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

const BUDGET_TTL_SECONDS = 95 * 24 * 60 * 60;
const DEFAULT_MONTHLY_CAP = 200;

/**
 * Monthly cap on leaf-health checks per household. Reads `LEAF_HEALTH_MONTHLY_CAP`
 * each call (cheap, and lets tests flip it). `<= 0` (or an unparseable value)
 * means "no cap" — see module docs.
 */
export function monthlyCap(): number {
  const raw = process.env.LEAF_HEALTH_MONTHLY_CAP;
  if (raw === undefined || raw === '') return DEFAULT_MONTHLY_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MONTHLY_CAP;
  return n;
}

export class LeafHealthBudgetExceededError extends Error {
  constructor() {
    super('Monthly leaf-health allowance exhausted');
    this.name = 'LeafHealthBudgetExceededError';
  }
}

/** UTC calendar month, e.g. "2026-06". Exported for tests (rollover). */
export function monthKey(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function budgetKey(householdId: string, now: Date): { PK: string; SK: string } {
  return {
    PK: 'LEAFHEALTH#BUDGET',
    SK: `MONTH#${monthKey(now)}#HH#${householdId}`,
  };
}

/**
 * Leaf-health checks used this month for the household.
 *
 * A MISSING row is a real zero — nothing has been spent this month. A FAILED
 * read is `null`: we do not know. These used to collapse to the same `0`,
 * which is the same defect already fixed in the sibling
 * `identifyBudget.getUsage` (see its docstring): a DynamoDB blip reported
 * "this household has used 0 of its 200 checks" with exactly the confidence
 * of a real reading. Nothing in `src/` consults this function today — the
 * live gate is the fail-CLOSED `reserveUsage` below — so this is a latent
 * trap rather than a live bug, and closing it is behaviour-preserving. But a
 * future caller wiring `isOverCap` in as the spend gate would have inherited
 * a guard that silently reports "under cap" whenever DynamoDB hiccups.
 */
export async function getUsage(
  householdId: string,
  now: Date = new Date()
): Promise<number | null> {
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: budgetKey(householdId, now) })
    );
    const used: unknown = result.Item?.used;
    return typeof used === 'number' && used > 0 ? used : 0;
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'leaf_health.budget_read_failed');
    return null;
  }
}

/**
 * True when the household has hit its monthly cap (and a cap is in effect).
 *
 * An UNKNOWN usage total (a failed read) is deliberately NOT treated as
 * over-cap: per this module's contract the spend cap must never take down the
 * feature itself, and the authoritative ceiling is `reserveUsage`'s
 * conditional write, not this advisory read. That decision is now explicit and
 * logged at the point it is made, instead of being laundered through a
 * stand-in zero inside `getUsage`. Behaviour is identical to before.
 */
export async function isOverCap(householdId: string, now: Date = new Date()): Promise<boolean> {
  const cap = monthlyCap();
  if (cap <= 0) return false; // unlimited
  const used = await getUsage(householdId, now);
  if (used === null) {
    logger.warn({ householdId }, 'leaf_health.over_cap_unknown_usage_treated_as_under_cap');
    return false;
  }
  return used >= cap;
}

/**
 * Atomically count one leaf-health check against the household's month.
 * Returns the new used total, or null when the write failed — callers treat a
 * failure as soft (the user already got their result; losing one tick of
 * metering is the better failure mode).
 */
export async function incrementUsage(
  householdId: string,
  now: Date = new Date()
): Promise<number | null> {
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: budgetKey(householdId, now),
        UpdateExpression:
          'ADD #used :one SET #ttl = if_not_exists(#ttl, :ttl), entityType = if_not_exists(entityType, :etype)',
        ExpressionAttributeNames: { '#used': 'used', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':ttl': Math.floor(now.getTime() / 1000) + BUDGET_TTL_SECONDS,
          ':etype': 'LeafHealthBudget',
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    const used: unknown = result.Attributes?.used;
    return typeof used === 'number' ? used : null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId },
      'leaf_health.budget_increment_failed'
    );
    return null;
  }
}

/**
 * Atomically reserve one Bedrock invocation while enforcing the monthly cap.
 *
 * The former read-then-invoke-then-increment sequence allowed concurrent
 * requests to all observe the same below-cap total and overspend the limit.
 * A conditional ADD makes the DynamoDB write the authoritative gate.
 */
export async function reserveUsage(
  householdId: string,
  cap: number,
  now: Date = new Date()
): Promise<number> {
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: budgetKey(householdId, now),
        UpdateExpression:
          'ADD #used :one SET #ttl = if_not_exists(#ttl, :ttl), entityType = if_not_exists(entityType, :etype)',
        ConditionExpression: 'attribute_not_exists(#used) OR #used < :cap',
        ExpressionAttributeNames: { '#used': 'used', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':cap': cap,
          ':ttl': Math.floor(now.getTime() / 1000) + BUDGET_TTL_SECONDS,
          ':etype': 'LeafHealthBudget',
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    const used: unknown = result.Attributes?.used;
    if (typeof used !== 'number') {
      throw new Error('Leaf-health reservation returned no usage total');
    }
    return used;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new LeafHealthBudgetExceededError();
    }
    logger.error({ err: (err as Error).message, householdId }, 'leaf_health.budget_reserve_failed');
    throw err;
  }
}

/**
 * Give back a reservation when Bedrock was not actually available and the
 * service returned its explicit demo response. Cleanup is best-effort; a
 * failed rollback must not hide the otherwise useful demo result.
 */
export async function releaseUsage(householdId: string, now: Date = new Date()): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: budgetKey(householdId, now),
        UpdateExpression: 'ADD #used :minusOne',
        ConditionExpression: 'attribute_exists(#used) AND #used > :zero',
        ExpressionAttributeNames: { '#used': 'used' },
        ExpressionAttributeValues: {
          ':minusOne': -1,
          ':zero': 0,
        },
      })
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'leaf_health.budget_release_failed');
  }
}
