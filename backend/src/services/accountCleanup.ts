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
        const reportedByUser = item.entityType === 'ChatReport' && item.userId === userId;
        if (!createdByUser && !assignedToUser && !reportedByUser) return;

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
          set.push('#assignedTo = :null', '#assignedToName = :null');
          remove.push('GSI2PK', 'GSI2SK');
          names['#assignedTo'] = 'assignedTo';
          names['#assignedToName'] = 'assignedToName';
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
