import type Stripe from 'stripe';
import { DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import * as billing from './billing.js';

const DELETED_USER_ID = 'deleted-user';
const DELETED_USER_NAME = 'Former member';

const CLEANUP_CONCURRENCY = 10;

async function mapBounded(
  items: Record<string, unknown>[],
  action: (item: Record<string, unknown>) => Promise<void>
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += CLEANUP_CONCURRENCY) {
    await Promise.all(items.slice(offset, offset + CLEANUP_CONCURRENCY).map(action));
  }
}

async function forEachQueryPage(
  input: ConstructorParameters<typeof QueryCommand>[0],
  action: (items: Record<string, unknown>[]) => Promise<void>
): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })
    );
    await action((result.Items ?? []) as Record<string, unknown>[]);
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
}

async function queryAllItems(
  input: ConstructorParameters<typeof QueryCommand>[0]
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  await forEachQueryPage(input, (page) => {
    items.push(...page);
    return Promise.resolve();
  });
  return items;
}

async function deleteItems(items: Record<string, unknown>[]): Promise<void> {
  await mapBounded(items, async (item) => {
    if (typeof item.PK !== 'string' || typeof item.SK !== 'string') return;
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: item.PK, SK: item.SK },
      })
    );
  });
}

export type SubscriptionCancellationOutcome =
  /** Nothing on file to cancel: free tier, or a lifetime (one-time) purchase. */
  | { outcome: 'no_subscription' }
  /** Stripe accepted the cancellation on this call. */
  | { outcome: 'canceled'; subscriptionId: string }
  /** Stripe already had it in a terminal state (an earlier attempt, the
   *  portal, or the dashboard); nothing more can be billed. */
  | { outcome: 'already_canceled'; subscriptionId: string }
  /** Stripe has no such subscription at all, so there is nothing to bill. */
  | { outcome: 'missing_in_stripe'; subscriptionId: string };

// Stripe statuses from which a subscription can never bill again.
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

function stripeErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * After a failed cancel call, ask Stripe whether the subscription is in fact
 * already dead. Returns the matching outcome, or null when Stripe either says
 * it is still live or cannot be reached — in which case the caller must treat
 * the original failure as real.
 */
async function confirmSubscriptionIsDead(
  stripe: Stripe,
  subscriptionId: string
): Promise<'already_canceled' | 'missing_in_stripe' | null> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status) ? 'already_canceled' : null;
  } catch (err) {
    return stripeErrorCode(err) === 'resource_missing' ? 'missing_in_stripe' : null;
  }
}

/**
 * Cancel the Stripe subscription of a household its sole member is about to
 * abandon through account deletion.
 *
 * Subscriptions belong to HOUSEHOLDS, not users (see models/plans.ts and the
 * HOUSEHOLD#{id}/METADATA row billing.ts reads and writes). A member leaving
 * a household that keeps other members must therefore never touch billing —
 * the household, its admin, and its plan all carry on. But when the ONLY
 * member deletes their account, deleteAbandonedHouseholdData erases the very
 * row that records the subscription, and cognitoUsers.deleteUser removes the
 * only identity that could have reached the billing portal to stop it. Left
 * alone, Stripe keeps charging a card for a household that no longer exists
 * and a person who can no longer log in. That is the gap this closes.
 *
 * Cancellation is immediate (not at period end): nobody remains to use the
 * rest of the paid period, and an "active until period end" subscription on
 * an erased household would just be a slower version of the same leak. No
 * proration or refund is requested — matching the lifetime-grant path in
 * billing.applyStripeEvent and Stripe's own default.
 *
 * Callers must run this BEFORE any destructive step and must treat a thrown
 * error as "refuse the deletion" (fail closed): losing a Stripe call must
 * never silently leave a deleted user paying.
 *
 * Retry-safe. Stripe — not the stored `subscriptionStatus` — is the source
 * of truth for whether anything is still billable: billing.ts documents a
 * window in which a freshly checked-out subscription id can sit next to a
 * stale `canceled` status, so a stored-status shortcut could skip cancelling
 * a live subscription. Instead every call with an id on file goes to Stripe
 * under a stable idempotency key (a replay within Stripe's window returns
 * the original result), and when the cancel call fails the subscription is
 * retrieved to check whether it is already in a terminal state or gone
 * entirely. Both count as success; anything else is rethrown.
 *
 * Deliberately NOT gated on the commercial hold (assertPaymentActivityAllowed):
 * that hold blocks the billing portal, which would otherwise leave account
 * deletion as a user's only way to stop being charged.
 */
export async function cancelAbandonedHouseholdSubscription(
  householdId: string
): Promise<SubscriptionCancellationOutcome> {
  const subscription = await billing.getHouseholdSubscription(householdId);
  const subscriptionId = subscription.stripeSubscriptionId;
  if (!subscriptionId) return { outcome: 'no_subscription' };

  const stripe = await billing.getStripe();
  try {
    await stripe.subscriptions.cancel(
      subscriptionId,
      {},
      { idempotencyKey: `account-deletion-cancel:${householdId}:${subscriptionId}` }
    );
    logger.info({ householdId, subscriptionId }, 'account_deletion_canceled_subscription');
    return { outcome: 'canceled', subscriptionId };
  } catch (err) {
    const dead = await confirmSubscriptionIsDead(stripe, subscriptionId);
    if (dead) {
      logger.info(
        { householdId, subscriptionId, outcome: dead },
        'account_deletion_subscription_already_dead'
      );
      return { outcome: dead, subscriptionId };
    }
    logger.error(
      { err, householdId, subscriptionId },
      'account_deletion_cancel_subscription_failed'
    );
    throw err;
  }
}

/**
 * Erase every row whose primary owner is the user.
 *
 * The USER partition contains notification preferences, phone-verification
 * challenges, browser/native device credentials, and reminder/digest/recap/
 * pest/welcome delivery markers. Deleting named row types leaves new marker
 * kinds behind as the notification system evolves, so account deletion owns
 * the partition boundary instead.
 */
export async function deleteUserScopedData(userId: string): Promise<void> {
  await forEachQueryPage(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${userId}` },
      ProjectionExpression: 'PK, SK',
    },
    (items) =>
      mapBounded(items, async (item) => {
        if (typeof item.PK !== 'string' || typeof item.SK !== 'string') return;
        await dynamodb.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { PK: item.PK, SK: item.SK },
          })
        );
      })
  );
}

/**
 * Delete every row owned by an abandoned household.
 *
 * Most household data (metadata, members, spaces, plants, tasks, API keys,
 * chat state, and vacation windows) shares the HOUSEHOLD#{id} partition.
 * Activity events use a dedicated partition, while sitter and kiosk
 * credentials each use a secret-token partition projected onto GSI1. Account
 * deletion must clear all four boundaries; deleting only the visible plants
 * leaves a usable sitter link or a live wall display and a substantial amount
 * of household data behind.
 *
 * Plant-specific S3 objects and per-plant rows are removed by
 * plantService.deletePlant before this runs. This final partition sweep is
 * intentionally generic so newly added household row types cannot become
 * account-erasure leaks.
 */
export async function deleteAbandonedHouseholdData(householdId: string): Promise<void> {
  const sitterItems = await queryAllItems({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#SITTER` },
    ProjectionExpression: 'PK, SK',
  });
  await deleteItems(sitterItems);

  // Kiosk links live in their own secret-token partition too, and unlike
  // sitter links they never expire — a surviving row would leave a wall
  // display reading a deleted household's task list forever.
  const kioskItems = await queryAllItems({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#KIOSK` },
    ProjectionExpression: 'PK, SK',
  });
  await deleteItems(kioskItems);

  const activityItems = await queryAllItems({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#ACTIVITY` },
    ProjectionExpression: 'PK, SK',
  });
  await deleteItems(activityItems);

  const householdItems = await queryAllItems({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}` },
    ProjectionExpression: 'PK, SK',
  });
  const members = householdItems.filter(
    (item) => typeof item.SK === 'string' && item.SK.startsWith('MEMBER#')
  );
  const metadata = householdItems.filter((item) => item.SK === 'METADATA');
  const ordinaryRows = householdItems.filter(
    (item) =>
      item.SK !== 'METADATA' && !(typeof item.SK === 'string' && item.SK.startsWith('MEMBER#'))
  );

  // The membership GSI row is the retry anchor used by DELETE /me. Keep it
  // until every other household row is gone; if any earlier delete fails, a
  // retry can still rediscover and finish this household instead of orphaning
  // a partially erased partition.
  await deleteItems(ordinaryRows);
  await deleteItems(metadata);
  await deleteItems(members);
}

/**
 * Remove a departing user's identity from household-owned history while
 * keeping the shared care record useful to the remaining members.
 *
 * We intentionally retain the fact that a task was completed or an action
 * happened. Names and stable user ids are replaced, active assignments are
 * cleared, and creator ids on retained household objects are anonymized.
 */
export async function anonymizeUserInHousehold(householdId: string, userId: string): Promise<void> {
  const plantIds: string[] = [];
  await forEachQueryPage(
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}` },
    },
    (householdItems) =>
      mapBounded(householdItems, async (item) => {
        if (item.entityType === 'Plant' && typeof item.id === 'string') plantIds.push(item.id);
        const key = { PK: item.PK, SK: item.SK };
        const vacationReferencesUser =
          item.entityType === 'VacationWindow' &&
          (item.userId === userId || item.coveredBy === userId);
        if (vacationReferencesUser) {
          await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));
          return;
        }
        const createdByUser = item.createdBy === userId;
        const assignedToUser = item.entityType === 'Task' && item.assignedTo === userId;
        const defaultCaregiverUser =
          item.entityType === 'PlantSpace' && item.defaultCaregiverId === userId;
        const reportedByUser = item.entityType === 'ChatReport' && item.userId === userId;
        if (!createdByUser && !assignedToUser && !defaultCaregiverUser && !reportedByUser) return;

        const set: string[] = [];
        const remove: string[] = [];
        const names: Record<string, string> = {};
        const values: Record<string, unknown> = {};
        if (createdByUser) {
          set.push('#createdBy = :deletedId');
          names['#createdBy'] = 'createdBy';
          values[':deletedId'] = DELETED_USER_ID;
        }
        if (assignedToUser) {
          set.push('#assignedTo = :null', '#assignedToName = :null', '#assignmentSource = :null');
          remove.push('GSI2PK', 'GSI2SK');
          names['#assignedTo'] = 'assignedTo';
          names['#assignedToName'] = 'assignedToName';
          names['#assignmentSource'] = 'assignmentSource';
          values[':null'] = null;
        }
        if (defaultCaregiverUser) {
          set.push('#defaultCaregiverId = :null');
          names['#defaultCaregiverId'] = 'defaultCaregiverId';
          values[':null'] = null;
        }
        if (reportedByUser) {
          set.push('#userId = :deletedId');
          names['#userId'] = 'userId';
          values[':deletedId'] = DELETED_USER_ID;
        }

        await dynamodb.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: key,
            UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ConditionExpression: 'attribute_exists(PK)',
          })
        );
      })
  );

  // Sitter credentials live outside the household's base partition. Retain
  // links for a shared household, but scrub the departed creator's stable id.
  await forEachQueryPage(
    {
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#SITTER` },
    },
    (links) =>
      mapBounded(
        links.filter((link) => link.createdBy === userId),
        async (link) => {
          await dynamodb.send(
            new UpdateCommand({
              TableName: TABLE_NAME,
              Key: { PK: link.PK, SK: link.SK },
              UpdateExpression: 'SET #createdBy = :deletedId',
              ExpressionAttributeNames: { '#createdBy': 'createdBy' },
              ExpressionAttributeValues: { ':deletedId': DELETED_USER_ID },
              ConditionExpression: 'attribute_exists(PK)',
            })
          );
        }
      )
  );

  // Kiosk credentials, same treatment: the household's wall display keeps
  // working when one member leaves, but the departed member's id is scrubbed.
  await forEachQueryPage(
    {
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#KIOSK` },
    },
    (links) =>
      mapBounded(
        links.filter((link) => link.createdBy === userId),
        async (link) => {
          await dynamodb.send(
            new UpdateCommand({
              TableName: TABLE_NAME,
              Key: { PK: link.PK, SK: link.SK },
              UpdateExpression: 'SET #createdBy = :deletedId',
              ExpressionAttributeNames: { '#createdBy': 'createdBy' },
              ExpressionAttributeValues: { ':deletedId': DELETED_USER_ID },
              ConditionExpression: 'attribute_exists(PK)',
            })
          );
        }
      )
  );

  // Photo timeline rows live in per-plant partitions rather than the base
  // household partition. Keep the shared photo but remove the uploader id.
  for (const plantId of plantIds) {
    await forEachQueryPage(
      {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
          ':sk': 'PHOTO#',
        },
      },
      (photos) =>
        mapBounded(
          photos.filter((photo) => photo.uploadedBy === userId),
          async (photo) => {
            await dynamodb.send(
              new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { PK: photo.PK, SK: photo.SK },
                UpdateExpression: 'SET #uploadedBy = :deletedId',
                ExpressionAttributeNames: { '#uploadedBy': 'uploadedBy' },
                ExpressionAttributeValues: { ':deletedId': DELETED_USER_ID },
                ConditionExpression: 'attribute_exists(PK)',
              })
            );
          }
        )
    );
  }

  await forEachQueryPage(
    {
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#ACTIVITY` },
    },
    (historyItems) =>
      mapBounded(historyItems, async (item) => {
        const isEvent = item.entityType === 'ActivityEvent' && item.actorId === userId;
        const isCompletion = item.entityType === 'TaskCompletion' && item.completedBy === userId;
        if (!isEvent && !isCompletion) return;
        await dynamodb.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: isEvent
              ? 'SET #actorId = :deletedId, #actorName = :deletedName'
              : 'SET #completedBy = :deletedId, #completedByName = :deletedName',
            ExpressionAttributeNames: isEvent
              ? { '#actorId': 'actorId', '#actorName': 'actorName' }
              : { '#completedBy': 'completedBy', '#completedByName': 'completedByName' },
            ExpressionAttributeValues: {
              ':deletedId': DELETED_USER_ID,
              ':deletedName': DELETED_USER_NAME,
            },
            ConditionExpression: 'attribute_exists(PK)',
          })
        );
      })
  );
}
