/**
 * Per-account milestones the web app reports to Google Analytics once and
 * only once. Today there is one: the account's first plant.
 *
 * Why the server decides. The web app used to send GA4 `first_plant_added`
 * whenever a first-run or empty-dashboard screen saved a plant, which counted
 * once per screen, not once per account: a second household, a household that
 * had removed all its plants, or a second device going through the first run
 * all counted again. A row in the account's own partition makes "first" a
 * fact the server records once, whatever device or household the plant comes
 * from.
 *
 * The row is `USER#<userId>` / `MILESTONE#FIRST_PLANT`, written with
 * `attribute_not_exists(PK)`, so exactly one create per account ever wins it.
 * It holds a timestamp and nothing else. Account deletion already erases the
 * whole USER partition (accountCleanup.deleteUserScopedData), so it goes with
 * the account.
 *
 * What counts as first. The account's first plant AND the only active plant
 * in its household right after the create. The second condition keeps the
 * accounts that had plants before this row existed from counting the next
 * plant they add: their first create after this ships claims the row and
 * reports nothing. A member who joins a household that already has plants
 * claims it the same way and is not counted either; `first_plant_added` is
 * about a new household getting started.
 *
 * A failure is its own answer, `'unknown'` (ADR 0010), never folded into
 * `'not_first'`. The caller fails closed on it: the create still succeeds and
 * no flag is sent. A lost event is better than a failed save, and far better
 * than a double count.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

export const FIRST_PLANT_MILESTONE_SK = 'MILESTONE#FIRST_PLANT';

/**
 * `first`: this create won the claim and left its household with one active
 * plant. `not_first`: the account had claimed it already, or the household
 * already had plants. `unknown`: DynamoDB failed, so nobody knows.
 */
export type FirstPlantClaim = 'first' | 'not_first' | 'unknown';

/**
 * Claim the account's first-plant milestone after a plant was created in
 * `householdId`. `'first'` only for the create that both wins the claim and
 * left the household with exactly one active plant. Call it after the plant
 * is saved, never before.
 */
export async function claimFirstPlant(
  userId: string,
  householdId: string
): Promise<FirstPlantClaim> {
  try {
    try {
      await dynamodb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `USER#${userId}`,
            SK: FIRST_PLANT_MILESTONE_SK,
            entityType: 'AccountMilestone',
            reachedAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
    } catch (err) {
      // Already claimed: this is not the account's first plant. The common
      // case for every plant after the first, so it is not logged.
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return 'not_first';
      }
      throw err;
    }

    // Read only after a successful claim, so later creates cost one write.
    // createPlant always leaves `plantCount` set (it seeds a legacy row).
    const meta = await dynamodb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        ProjectionExpression: 'plantCount',
      })
    );
    return meta.Item?.plantCount === 1 ? 'first' : 'not_first';
  } catch {
    return 'unknown';
  }
}
