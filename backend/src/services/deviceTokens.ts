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
 * These have a DELIVERY reader: `notifier.sendDevicePush` sends to what
 * `getUserDeviceTokens` returns and deletes the rows APNs or FCM reports as
 * unregistered. The channel is off until the owner setup in
 * docs/native-push-setup.md is done and `native_push_enabled` is switched on.
 *
 * Lifecycle, and who removes a row:
 *   - created when the person turns notifications on in the app
 *     (`POST /notifications/devices`), and taken over from any other user who
 *     held the same token (see `saveDeviceToken`);
 *   - removed when they turn it off on that device
 *     (`POST /notifications/devices/remove`), or sign out on it
 *     (`POST /notifications/devices/release`, which needs no session);
 *   - removed when they leave or are removed from the household it was
 *     registered under (`deleteDeviceTokensForHousehold`);
 *   - removed with the account (`accountCleanup.deleteUserScopedData` sweeps
 *     the whole `USER#` partition);
 *   - removed when APNs or FCM says the token is dead.
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

/** The primary keys of `items`, skipping any row without string keys. */
function rowKeys(
  items: Array<Record<string, unknown>> | undefined
): Array<{ PK: string; SK: string }> {
  const keys: Array<{ PK: string; SK: string }> = [];
  for (const item of items ?? []) {
    if (typeof item.PK === 'string' && typeof item.SK === 'string') {
      keys.push({ PK: item.PK, SK: item.SK });
    }
  }
  return keys;
}

/**
 * The GSI1 partition every row for one physical device token shares, across
 * users. Full SHA-256, not the 64-bit SK form: this key decides whose row
 * gets DELETED, so a collision would cost someone their registration.
 */
function deviceIndexKey(token: string): string {
  return `DEVICE_TOKEN#${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * Register a device for a user — and make it that user's ALONE.
 *
 * Storage (single table):
 *   PK: USER#{userId}                         SK: DEVICE#{sha256(token)[:16]}
 *   GSI1PK: DEVICE_TOKEN#{sha256(token)}      GSI1SK: USER#{userId}
 *
 * The base row lives in the user's partition so account deletion's generic
 * `USER#` sweep erases it. The GSI1 projection is what makes a device belong
 * to one person at a time: APNs hands the same app installation the same
 * token again after a sign-out and a sign-in, so without it the previous
 * user's row would keep pointing at this phone and their reminders — plant
 * names, household tasks — would arrive on the next person's lock screen.
 * Every other user's row for this token is deleted here, before this one is
 * written. (GSI reads are eventually consistent; a row written in the same
 * second can survive one registration and is removed by the next, or by the
 * next send's dead-token cleanup once the old owner's token stops resolving.)
 */
export async function saveDeviceToken(record: StoredDeviceToken): Promise<void> {
  const indexKey = deviceIndexKey(record.token);
  const others = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': indexKey },
      ProjectionExpression: 'PK, SK',
    })
  );
  await Promise.all(
    rowKeys(others.Items)
      .filter((key) => key.PK !== `USER#${record.userId}`)
      .map((Key) => dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key })))
  );
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${record.userId}`,
        SK: `DEVICE#${tokenKey(record.token)}`,
        GSI1PK: indexKey,
        GSI1SK: `USER#${record.userId}`,
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

/**
 * Remove this user's devices that were registered while `householdId` was
 * their household, when they leave it or are removed from it.
 *
 * A device row names the household it was registered under. Once the person
 * is out of that household the row is a stale link between them, a phone and
 * a household they no longer belong to, so it goes with the rest of the
 * departure (householdDeparture.ts, step 4). If they still belong to another
 * household and still want push, the app registers the device again when it
 * next opens, at most six hours later (`syncNativePush()` in the frontend),
 * under the household they have now.
 *
 * Returns how many rows were removed.
 */
export async function deleteDeviceTokensForHousehold(
  userId: string,
  householdId: string
): Promise<number> {
  let removed = 0;
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
        ProjectionExpression: 'PK, SK, householdId',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    const matching = rowKeys(
      (result.Items ?? []).filter((item) => item.householdId === householdId)
    );
    await Promise.all(
      matching.map((Key) => dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key })))
    );
    removed += matching.length;
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return removed;
}

/** How many devices this user has registered, for the "last device off" decision. */
export async function countUserDeviceTokens(userId: string): Promise<number> {
  let count = 0;
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
        Select: 'COUNT',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    count += result.Count ?? 0;
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return count;
}

/**
 * Remove every account's row for one physical device token: signing out on
 * that device.
 *
 * Deliberately keyed on the token alone, because this runs when the session
 * may already be gone — a refresh that was refused signs the person out with
 * no valid token to authenticate a call with, and without this their
 * reminders (plant names, household tasks) would keep arriving on a phone the
 * next person signs in to. Holding the device token is the credential: it is
 * issued to the app on that device only, and the worst anyone holding it can
 * do is stop notifications to that device.
 *
 * Returns how many rows were removed; the handler never reveals it.
 */
export async function releaseDeviceToken(token: string): Promise<number> {
  const rows = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': deviceIndexKey(token) },
      ProjectionExpression: 'PK, SK',
    })
  );
  const keys = rowKeys(rows.Items);
  await Promise.all(
    keys.map((Key) => dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key })))
  );
  return keys.length;
}
