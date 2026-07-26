import { createHash } from 'node:crypto';
import { PutCommand, GetCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import createHttpError from 'http-errors';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { isAllowedPushEndpoint } from './pushEndpoint.js';

export { isAllowedPushEndpoint } from './pushEndpoint.js';

export interface StoredPushSubscription {
  userId: string;
  householdId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

const MAX_SUBSCRIPTIONS_PER_USER = 20;
const SUBSCRIPTION_QUERY_PAGE_SIZE = 100;

/**
 * Sub records live under the user partition so a user can have multiple
 * (one per device). Endpoint is hashed into the SK so we can dedupe.
 */
function endpointKey(endpoint: string): string {
  // Hashing to keep SKs short and predictable; the endpoint URL is too long
  // and contains URL-unsafe chars for a SK. Truncated SHA-256 (64 bits) —
  // the previous 32-bit rolling hash had a realistic birthday-collision risk
  // across endpoints, which would silently overwrite one device's
  // subscription with another's.
  //
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

interface StoredPushSubscriptionRow extends StoredPushSubscription {
  PK: string;
  SK: string;
}

/**
 * Read the complete push partition with the physical keys intact.
 *
 * Keeping the SK matters during the rolling-hash → SHA migration: an endpoint
 * may exist under both keys, and a legacy 32-bit collision means we must only
 * delete a row after confirming that its stored endpoint is the one being
 * revoked. Consistent reads make an unsubscribe immediately authoritative.
 */
async function getUserSubscriptionRows(userId: string): Promise<StoredPushSubscriptionRow[]> {
  const rows: StoredPushSubscriptionRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}`,
          ':sk': 'PUSH#',
        },
        ConsistentRead: true,
        Limit: SUBSCRIPTION_QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of result.Items ?? []) {
      if (typeof item.PK !== 'string' || typeof item.SK !== 'string') continue;
      rows.push(item as StoredPushSubscriptionRow);
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return rows;
}

export async function saveSubscription(sub: StoredPushSubscription): Promise<void> {
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    throw createHttpError(
      400,
      'Push endpoint must be an HTTPS endpoint issued by a supported browser push service'
    );
  }
  const existingRows = await getUserSubscriptionRows(sub.userId);
  const existingEndpoints = new Set(
    existingRows
      .map((stored) => stored.endpoint)
      .filter((endpoint): endpoint is string => typeof endpoint === 'string')
  );
  if (
    existingEndpoints.size >= MAX_SUBSCRIPTIONS_PER_USER &&
    !existingEndpoints.has(sub.endpoint)
  ) {
    throw createHttpError(
      409,
      `A maximum of ${MAX_SUBSCRIPTIONS_PER_USER} browser subscriptions is supported`
    );
  }
  const canonicalSk = `PUSH#${endpointKey(sub.endpoint)}`;
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${sub.userId}`,
        SK: canonicalSk,
        entityType: 'PushSubscription',
        ...sub,
      },
    })
  );

  // A browser that subscribed before the key migration may still have the
  // same endpoint under the old rolling-hash SK. Remove only rows whose
  // stored endpoint matches; a legacy hash collision can otherwise point at
  // another real device owned by this user.
  await Promise.all(
    existingRows
      .filter((row) => row.endpoint === sub.endpoint && row.SK !== canonicalSk)
      .map((row) =>
        dynamodb.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { PK: row.PK, SK: row.SK },
          })
        )
      )
  );
}

export async function deleteSubscription(userId: string, endpoint: string): Promise<number> {
  const rows = await getUserSubscriptionRows(userId);
  const matchingKeys = new Map<string, { PK: string; SK: string }>();

  // Always address the canonical key even when the row is already absent.
  // This keeps unsubscribe idempotent and closes the tiny read/delete race
  // with a just-completed canonical registration.
  const canonical = {
    PK: `USER#${userId}`,
    SK: `PUSH#${endpointKey(endpoint)}`,
  };
  matchingKeys.set(`${canonical.PK}\0${canonical.SK}`, canonical);
  for (const row of rows) {
    if (row.endpoint !== endpoint) continue;
    matchingKeys.set(`${row.PK}\0${row.SK}`, { PK: row.PK, SK: row.SK });
  }

  await Promise.all(
    [...matchingKeys.values()].map((key) =>
      dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }))
    )
  );
  // Return an authoritative post-delete count so disabling push on this
  // device does not accidentally disable the user's other subscribed devices.
  return (await getUserSubscriptions(userId)).length;
}

export async function getUserSubscriptions(userId: string): Promise<StoredPushSubscription[]> {
  const rows = await getUserSubscriptionRows(userId);
  const byEndpoint = new Map<string, StoredPushSubscription>();
  for (const item of rows) {
    if (typeof item.endpoint !== 'string') continue;
    const candidate: StoredPushSubscription = {
      userId: item.userId,
      householdId: item.householdId,
      endpoint: item.endpoint,
      keys: item.keys,
      createdAt: item.createdAt,
    };
    const existing = byEndpoint.get(candidate.endpoint);
    if (!existing || candidate.createdAt > existing.createdAt) {
      byEndpoint.set(candidate.endpoint, candidate);
    }
  }
  // The write path enforces this cap, but slice defensively for historical
  // data so one damaged partition cannot create an unbounded fan-out.
  return [...byEndpoint.values()].slice(0, MAX_SUBSCRIPTIONS_PER_USER);
}

/**
 * Remove every browser push credential owned by a user.
 *
 * The normal delivery read is intentionally capped at 20 devices, but account
 * deletion is a privacy boundary and must follow every DynamoDB page instead
 * of leaving older endpoints behind.
 */
export async function deleteUserSubscriptions(userId: string): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}`,
          ':sk': 'PUSH#',
        },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    await Promise.all(
      (result.Items ?? []).map((item) => {
        const pk = typeof item.PK === 'string' ? item.PK : '';
        const sk = typeof item.SK === 'string' ? item.SK : '';
        if (!pk || !sk) return Promise.resolve();
        return dynamodb.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { PK: pk, SK: sk },
          })
        );
      })
    );
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
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
