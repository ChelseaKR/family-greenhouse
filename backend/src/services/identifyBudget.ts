/**
 * Per-household monthly metering for Plant.id identifications.
 *
 * Every identification costs real money upstream, so usage is tracked per
 * household per calendar month (UTC) and surfaced to the client on every
 * identify response. ENFORCEMENT is env-gated behind
 * `IDENTIFY_METERING_ENABLED=1` (default OFF): during beta we track usage but
 * never block, so flipping the flag later launches the tier perk without a
 * deploy-time behavior change for anyone under their allowance.
 *
 * Storage (same single-partition shape as the weather daily budget in
 * services/climate.ts, but month-granular and household-keyed):
 *
 *   PK: IDENTIFY#BUDGET
 *   SK: MONTH#{yyyy-mm}#HH#{householdId}
 *   used: number (atomic ADD)
 *   ttl:  ~95 days (same retention as the chat budget rows)
 *
 * Volume is tiny — allowances cap at 100/household/month and the identify
 * route is rate-limited at 10/min/user — so a single partition is fine.
 *
 * Users who haven't joined a household yet can still identify (the route has
 * no requireHousehold); callers meter those under a `user:{userId}` bucket so
 * onboarding traffic is never unmetered.
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { PlanId } from '../models/plans.js';

/**
 * Monthly identification allowances per plan. Defined here (not in
 * models/plans.ts, which is owned by the plan-catalog domain) because they
 * are a metering concern: the catalog caps are hard structural limits, these
 * are soft upstream-cost budgets.
 */
export const IDENTIFY_ALLOWANCES: Record<PlanId, number> = {
  seedling: 3,
  garden: 30,
  greenhouse: 100,
};

export function allowanceForPlan(planId: PlanId): number {
  return IDENTIFY_ALLOWANCES[planId] ?? IDENTIFY_ALLOWANCES.seedling;
}

/** Enforcement switch. Tracking always runs; blocking only when this is on. */
export function meteringEnabled(): boolean {
  return process.env.IDENTIFY_METERING_ENABLED === '1';
}

const BUDGET_TTL_SECONDS = 95 * 24 * 60 * 60;

/** UTC calendar month, e.g. "2026-06". Exported for tests (rollover). */
export function monthKey(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function budgetKey(bucketId: string, now: Date): { PK: string; SK: string } {
  return {
    PK: 'IDENTIFY#BUDGET',
    SK: `MONTH#${monthKey(now)}#HH#${bucketId}`,
  };
}

/**
 * Identifications used this month for the bucket (householdId, or
 * `user:{userId}` for householdless callers). Missing row → 0. DDB failures
 * fail OPEN (0 + a warn log): metering must never take down the identify
 * feature itself.
 */
export async function getUsage(bucketId: string, now: Date = new Date()): Promise<number> {
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: budgetKey(bucketId, now) })
    );
    const used: unknown = result.Item?.used;
    return typeof used === 'number' && used > 0 ? used : 0;
  } catch (err) {
    logger.warn({ err: (err as Error).message, bucketId }, 'identify.budget_read_failed');
    return 0;
  }
}

/**
 * Atomically count one successful identification against the bucket's month.
 * Returns the new used total, or null when the write failed — callers must
 * treat a failure as soft (the user already got their identification; losing
 * one tick of metering is the better failure mode).
 */
export async function incrementUsage(
  bucketId: string,
  now: Date = new Date()
): Promise<number | null> {
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: budgetKey(bucketId, now),
        UpdateExpression:
          'ADD #used :one SET #ttl = if_not_exists(#ttl, :ttl), entityType = if_not_exists(entityType, :etype)',
        ExpressionAttributeNames: { '#used': 'used', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':ttl': Math.floor(now.getTime() / 1000) + BUDGET_TTL_SECONDS,
          ':etype': 'IdentifyBudget',
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    const used: unknown = result.Attributes?.used;
    return typeof used === 'number' ? used : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, bucketId }, 'identify.budget_increment_failed');
    return null;
  }
}
