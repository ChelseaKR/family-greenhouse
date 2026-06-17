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
 * Leaf-health checks used this month for the household. Missing row → 0. DDB
 * failures fail OPEN (0 + a warn log): the spend cap must never take down the
 * feature itself.
 */
export async function getUsage(householdId: string, now: Date = new Date()): Promise<number> {
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: budgetKey(householdId, now) })
    );
    const used: unknown = result.Item?.used;
    return typeof used === 'number' && used > 0 ? used : 0;
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'leaf_health.budget_read_failed');
    return 0;
  }
}

/**
 * True when the household has hit its monthly cap (and a cap is in effect).
 * Reads usage and compares; callers gate the Bedrock call on this.
 */
export async function isOverCap(householdId: string, now: Date = new Date()): Promise<boolean> {
  const cap = monthlyCap();
  if (cap <= 0) return false; // unlimited
  const used = await getUsage(householdId, now);
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
