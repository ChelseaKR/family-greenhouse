import { createHash } from 'node:crypto';
import { PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

/**
 * Native (iOS/Android) push device tokens, registered by the Capacitor mobile
 * shells. Mirrors pushSubscriptions.ts: one row per device under the user
 * partition, token hashed into the SK for dedupe (re-registering the same
 * device overwrites its row instead of accumulating duplicates).
 *
 * These now have a DELIVERY reader: `notifier.sendDevicePush` sends to what
 * `getUserDeviceTokens` returns and deletes the rows FCM reports as
 * unregistered. The channel is still dark end to end — no Firebase project
 * and no service-account secret exist yet (docs/mobile.md § Push
 * notifications) — but the storage side is no longer capture-only, which is
 * why the read below had to stop handing back one DynamoDB page.
 */

export interface StoredDeviceToken {
  userId: string;
  householdId: string;
  platform: 'ios' | 'android';
  token: string;
  createdAt: string;
}

/**
 * Delivery fan-out cap, matching `pushSubscriptions`' 20 browser
 * subscriptions. It is applied to the NEWEST rows, after following every
 * page — a cap on the first page DynamoDB happened to return would silently
 * pick a user's devices for them.
 *
 * Unlike the browser side there is no matching cap on the write path, because
 * FCM registration tokens ROTATE: a device that reinstalls or refreshes its
 * token registers a new row and the old one is never revoked by the client.
 * Refusing the write would lock a real device out. Pruning is what keeps the
 * partition small instead — every send deletes the tokens FCM reports as
 * `UNREGISTERED`, so rotated rows disappear on the first reminder after the
 * rotation. `device_tokens_capped` below is the signal that this is not
 * keeping up.
 */
const MAX_DEVICE_TOKENS_PER_USER = 20;
const DEVICE_TOKEN_QUERY_PAGE_SIZE = 100;

function tokenKey(token: string): string {
  // Same scheme as pushSubscriptions.endpointKey: truncated SHA-256 (64 bits)
  // keeps the SK short/URL-safe with negligible collision risk.
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export async function saveDeviceToken(record: StoredDeviceToken): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${record.userId}`,
        SK: `DEVICE#${tokenKey(record.token)}`,
        entityType: 'DeviceToken',
        ...record,
      },
    })
  );
}

export async function deleteDeviceToken(userId: string, token: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: `DEVICE#${tokenKey(token)}` },
    })
  );
}

/**
 * Every device this user can be reached on, newest first, capped for the
 * fan-out at {@link MAX_DEVICE_TOKENS_PER_USER}.
 *
 * Follows `LastEvaluatedKey`. It used to return a single 20-item page, which
 * was defensible while nothing sent to the result and is not now: token
 * rotation means the oldest rows in a partition are the DEAD ones, so a
 * first-page read is the read most likely to contain only tokens that no
 * longer resolve to a device — a user with a working phone getting nothing,
 * hourly, with every request succeeding.
 */
export async function getUserDeviceTokens(userId: string): Promise<StoredDeviceToken[]> {
  const byToken = new Map<string, StoredDeviceToken>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}`,
          ':sk': 'DEVICE#',
        },
        Limit: DEVICE_TOKEN_QUERY_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of result.Items ?? []) {
      if (typeof item.token !== 'string') continue;
      const candidate: StoredDeviceToken = {
        userId: item.userId as string,
        householdId: item.householdId as string,
        platform: item.platform as 'ios' | 'android',
        token: item.token,
        createdAt: item.createdAt as string,
      };
      const existing = byToken.get(candidate.token);
      if (!existing || candidate.createdAt > existing.createdAt) {
        byToken.set(candidate.token, candidate);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  if (byToken.size > MAX_DEVICE_TOKENS_PER_USER) {
    // Says the cap bound this read. Without it the cap is invisible at
    // exactly the moment it starts dropping a real device.
    logger.warn(
      { userId, count: byToken.size, cap: MAX_DEVICE_TOKENS_PER_USER, msg: 'device_tokens_capped' },
      'device_tokens_capped'
    );
  }
  return [...byToken.values()]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, MAX_DEVICE_TOKENS_PER_USER);
}

/**
 * Remove every native push token owned by a user.
 *
 * Account deletion must not leave an APNs/FCM credential behind. Both reads
 * follow DynamoDB pagination now, but this one queries keys directly rather
 * than going through `getUserDeviceTokens` so it is not bound by that
 * function's 20-device DELIVERY cap: erasure has to reach every row,
 * including the ones a fan-out would have skipped.
 */
export async function deleteUserDeviceTokens(userId: string): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}`,
          ':sk': 'DEVICE#',
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
