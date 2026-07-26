import { DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

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
 * Activity events use a dedicated partition, while sitter credentials use a
 * secret-token partition projected onto GSI1. Account deletion must clear all
 * three boundaries; deleting only the visible plants leaves a usable sitter
 * link and a substantial amount of household data behind.
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
