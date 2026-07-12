import { createHash } from 'node:crypto';
import { PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

/**
 * Native (iOS/Android) push device tokens, registered by the Capacitor mobile
 * shells. Mirrors pushSubscriptions.ts: one row per device under the user
 * partition, token hashed into the SK for dedupe (re-registering the same
 * device overwrites its row instead of accumulating duplicates).
 *
 * CAPTURE-ONLY for now: reminders do not yet fan out to these tokens — the
 * APNs/FCM sender is a follow-up that needs Firebase / Apple Push credentials
 * (see docs/mobile.md § Push notifications). Registering tokens from the
 * first shipped app build means the sender lights up for existing installs
 * the day it lands, instead of waiting for every user to reopen the app.
 */

export interface StoredDeviceToken {
  userId: string;
  householdId: string;
  platform: 'ios' | 'android';
  token: string;
  createdAt: string;
}

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

export async function getUserDeviceTokens(userId: string): Promise<StoredDeviceToken[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':sk': 'DEVICE#',
      },
      Limit: 20,
    })
  );
  return (result.Items ?? []).map((item) => ({
    userId: item.userId as string,
    householdId: item.householdId as string,
    platform: item.platform as 'ios' | 'android',
    token: item.token as string,
    createdAt: item.createdAt as string,
  }));
}
