/**
 * Read-only access to the atomic usage counters that live on the household
 * METADATA row (`plantCount`, `memberCount` — maintained transactionally by
 * plantService / householdService; see householdService.addMember for the
 * counter discipline).
 *
 * Used by GET /billing/me to surface "n of max" usage so the UI can show
 * meters and an over-limit banner after a downgrade. Deliberately tolerant:
 * legacy households predate the counters and the backfill is lazy, so a
 * missing attribute (or even a failed read) reports 0 rather than erroring —
 * billing/me must never 500 because a counter hasn't been seeded yet.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

export interface HouseholdCounters {
  plantCount: number;
  memberCount: number;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export async function getHouseholdCounters(householdId: string): Promise<HouseholdCounters> {
  try {
    const result = await dynamodb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
      })
    );
    return {
      plantCount: asCount(result.Item?.plantCount),
      memberCount: asCount(result.Item?.memberCount),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'household_counters_read_failed');
    return { plantCount: 0, memberCount: 0 };
  }
}
