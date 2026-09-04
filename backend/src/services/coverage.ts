/**
 * Coverage report — the DynamoDB reads behind `GET /households/:id/analytics/coverage`.
 *
 * Design rule (the full statement is at the top of coverageMath.ts): this is
 * a fragility view, not a leaderboard. This file only gathers inputs; it
 * never aggregates anything per member.
 *
 * Marginal cost per household: $0. The four reads are the roster, the active
 * plant list, the vacation windows and the household's completion history —
 * all of which the analytics page and the year-in-review already query — and
 * the rest is arithmetic. The history read is bounded to three projected
 * attributes so the all-time scan stays cheap even for a busy household.
 *
 * Failure is loud: any read that throws propagates to the handler as a 5xx.
 * A coverage report must never be assembled from a partial read, because
 * "0 plants at risk" computed from an empty page is the exact
 * absence-rendered-as-a-value defect this repo names.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import * as householdService from './householdService.js';
import * as plantService from './plantService.js';
import * as taskService from './taskService.js';
import { computeCoverage } from './coverageMath.js';
import type { CoverageCompletion, CoverageReport } from './coverageMath.js';

const PAGE_LIMIT = 200;

/**
 * Run a Query and follow LastEvaluatedKey to exhaustion — the same shape as
 * taskService's private helper. A single Limit-bounded page silently
 * truncates, and truncation here would understate the caregiver set.
 */
async function queryAllPages(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

/**
 * Every completion the household has ever logged, reduced to the two fields
 * coverage reasons about. Reads the GSI1 `HOUSEHOLD#{id}#ACTIVITY` partition
 * that the year-in-review already scans, with no date bound ("ever") and a
 * projection so the payload is three attributes per row, not the whole item.
 */
export async function listAllCompletions(householdId: string): Promise<CoverageCompletion[]> {
  const items = await queryAllPages({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ProjectionExpression: '#et, #plant, #by',
    ExpressionAttributeNames: {
      '#et': 'entityType',
      '#plant': 'plantId',
      '#by': 'completedBy',
    },
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
    },
    Limit: PAGE_LIMIT,
  });

  const completions: CoverageCompletion[] = [];
  for (const item of items) {
    // The partition also carries ActivityEvent rows; only completions count.
    if (item.entityType !== 'TaskCompletion') continue;
    completions.push({
      plantId: item.plantId as string,
      completedBy: item.completedBy as string,
    });
  }
  return completions;
}

export async function getCoverageReport(
  householdId: string,
  now: Date = new Date()
): Promise<CoverageReport> {
  // Independent reads, so a slow one never serializes the others. Any
  // rejection rejects the whole report — see the module header.
  const [members, plants, windows, completions] = await Promise.all([
    householdService.getHouseholdMembers(householdId),
    plantService.getPlants(householdId),
    taskService.listVacationWindows(householdId, now),
    listAllCompletions(householdId),
  ]);

  return computeCoverage({
    members: members.map((m) => ({ userId: m.userId, name: m.name })),
    plants: plants.map((p) => ({ id: p.id, name: p.name })),
    completions,
    windows,
    now,
  });
}
