import { PutCommand, GetCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

export interface StoredPushSubscription {
  userId: string;
  householdId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

/**
 * Sub records live under the user partition so a user can have multiple
 * (one per device). Endpoint is hashed into the SK so we can dedupe.
 */
function endpointKey(endpoint: string): string {
  // Hashing to keep SKs short and predictable; the endpoint URL is too long
  // and contains URL-unsafe chars for a SK.
  let hash = 0;
  for (let i = 0; i < endpoint.length; i++) {
    hash = (hash * 31 + endpoint.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export async function saveSubscription(sub: StoredPushSubscription): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${sub.userId}`,
        SK: `PUSH#${endpointKey(sub.endpoint)}`,
        entityType: 'PushSubscription',
        ...sub,
      },
    })
  );
}

export async function deleteSubscription(userId: string, endpoint: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: `PUSH#${endpointKey(endpoint)}` },
    })
  );
}

export async function getUserSubscriptions(userId: string): Promise<StoredPushSubscription[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':sk': 'PUSH#',
      },
      Limit: 20,
    })
  );
  return (result.Items ?? []).map((item) => ({
    userId: item.userId as string,
    householdId: item.householdId as string,
    endpoint: item.endpoint as string,
    keys: item.keys as { p256dh: string; auth: string },
    createdAt: item.createdAt as string,
  }));
}

// Acknowledge a no-op: getHouseholdSubscriptions intentionally not implemented
// here because we don't index push subs by household. The reminder Lambda
// derives them by walking household members → user → subs.
export async function _internal_getOne(
  userId: string,
  endpoint: string
): Promise<StoredPushSubscription | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: `PUSH#${endpointKey(endpoint)}` },
    })
  );
  if (!result.Item) return null;
  return result.Item as unknown as StoredPushSubscription;
}
