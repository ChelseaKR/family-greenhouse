/**
 * DynamoDB storage for the household chat channel (#674).
 *
 * ```
 * PK: HOUSEHOLD#{householdId}
 * SK: CHANNEL#WEBHOOK
 * GSI1PK: HOUSEHOLD_CHANNELS       ← sparse: only households with a channel
 * GSI1SK: HOUSEHOLD#{householdId}
 * entityType: HouseholdChannel
 * …HouseholdChannelRecord (sealedUrl is KMS ciphertext, never the address)
 *
 * PK: HOUSEHOLD#{householdId}
 * SK: CHANNELPOST#{daily_due|up_for_grabs}#{localDate|isoWeek}
 * entityType: ChannelPostMarker
 * status: sending|sent, reservationId, leaseExpiresAt, sentAt, ttl
 * ```
 *
 * The row lives in the household's own partition, so account erasure's
 * generic partition sweep (`accountCleanup.deleteAbandonedHouseholdData`)
 * removes it with everything else — no new erasure boundary. The sparse GSI1
 * projection is how the hourly pass finds the few households that have a
 * channel without scanning the table or reading a row per household.
 *
 * Every read here either returns a settled answer or throws. There is no
 * "could not read, so no channel" path: that would make a DynamoDB blip look
 * like a household that disconnected (ADR 0010).
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import {
  CHANNEL_LOCALES,
  CHANNEL_PLATFORMS,
  type ChannelFailure,
  type HouseholdChannelRecord,
} from '../models/householdChannel.js';

export const CHANNEL_INDEX_PK = 'HOUSEHOLD_CHANNELS';
const CHANNEL_SK = 'CHANNEL#WEBHOOK';

export type ChannelPostKind = 'daily_due' | 'up_for_grabs';

/** Long enough for a weekly key to outlive its week; TTL sweeps the rest. */
const POST_MARKER_TTL_SECONDS = 9 * 24 * 60 * 60;
/** A killed Lambda's reservation is reclaimable by the next hourly run. */
const POST_LEASE_SECONDS = 5 * 60;

function channelKey(householdId: string) {
  return { PK: `HOUSEHOLD#${householdId}`, SK: CHANNEL_SK };
}

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function asFailure(value: unknown): ChannelFailure | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const at = asString(raw.at);
  const kind = asString(raw.kind);
  if (!at || !kind) return null;
  return {
    at,
    kind: kind as ChannelFailure['kind'],
    httpStatus: typeof raw.httpStatus === 'number' ? raw.httpStatus : null,
  };
}

/**
 * Build the record from a stored item by NAMING every field. Anything else on
 * the row — a future attribute, a stray debug field — can never reach a
 * summary or a response by being spread.
 */
export function recordFromItem(item: Record<string, unknown>): HouseholdChannelRecord | null {
  const householdId = asString(item.householdId);
  const platform = asString(item.platform);
  const sealedUrl = asString(item.sealedUrl);
  const urlVersion = asString(item.urlVersion);
  if (!householdId || !sealedUrl || !urlVersion) return null;
  if (!CHANNEL_PLATFORMS.includes(platform as (typeof CHANNEL_PLATFORMS)[number])) return null;
  const events = (item.events ?? {}) as Record<string, unknown>;
  const locale = asString(item.locale);
  return {
    householdId,
    platform: platform as HouseholdChannelRecord['platform'],
    sealedUrl,
    urlVersion,
    host: asString(item.host) ?? '',
    last4: asString(item.last4) ?? '',
    events: { dailyDue: events.dailyDue === true, upForGrabs: events.upForGrabs === true },
    quietStart: asString(item.quietStart) ?? '',
    quietEnd: asString(item.quietEnd) ?? '',
    timezone: asString(item.timezone) ?? 'UTC',
    locale: CHANNEL_LOCALES.includes(locale as 'en' | 'es') ? (locale as 'en' | 'es') : 'en',
    status: item.status === 'disabled' ? 'disabled' : 'active',
    disabledReason: (asString(item.disabledReason) ??
      null) as HouseholdChannelRecord['disabledReason'],
    consecutiveFailures: asCount(item.consecutiveFailures),
    consecutiveClientErrors: asCount(item.consecutiveClientErrors),
    nextAttemptAt: asString(item.nextAttemptAt),
    lastFailure: asFailure(item.lastFailure),
    lastDeliveredAt: asString(item.lastDeliveredAt),
    lastTestAt: asString(item.lastTestAt),
    connectedBy: asString(item.connectedBy) ?? '',
    connectedAt: asString(item.connectedAt) ?? '',
    updatedAt: asString(item.updatedAt) ?? '',
  };
}

/** The household's channel, or null when it has none. Throws on a failed read. */
export async function getChannel(householdId: string): Promise<HouseholdChannelRecord | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: channelKey(householdId), ConsistentRead: true })
  );
  if (!result.Item) return null;
  return recordFromItem(result.Item as Record<string, unknown>);
}

/**
 * Write the whole row. Optimistic: `expectUpdatedAt` null means "there must
 * be no row yet", otherwise the stored row must still carry that `updatedAt`.
 * Two admins saving at once get one success and one `conflict`, never a
 * silently merged half of each.
 */
export async function saveChannel(
  record: HouseholdChannelRecord,
  expectUpdatedAt: string | null
): Promise<'saved' | 'conflict'> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...channelKey(record.householdId),
          GSI1PK: CHANNEL_INDEX_PK,
          GSI1SK: `HOUSEHOLD#${record.householdId}`,
          entityType: 'HouseholdChannel',
          ...record,
        },
        ...(expectUpdatedAt === null
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: 'updatedAt = :expected',
              ExpressionAttributeValues: { ':expected': expectUpdatedAt },
            }),
      })
    );
    return 'saved';
  } catch (err) {
    if (isConditionalFailure(err)) return 'conflict';
    throw err;
  }
}

/** Remove the channel. True when there was one. The next hourly pass lists
 *  channels afresh, so delivery stops within one run. */
export async function deleteChannel(householdId: string): Promise<boolean> {
  const result = await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: channelKey(householdId),
      ReturnValues: 'ALL_OLD',
    })
  );
  return Boolean(result.Attributes);
}

/** Every configured channel, following every page. */
export async function listChannels(): Promise<HouseholdChannelRecord[]> {
  const records: HouseholdChannelRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': CHANNEL_INDEX_PK },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of result.Items ?? []) {
      const record = recordFromItem(item as Record<string, unknown>);
      if (record) records.push(record);
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return records;
}

/** Fields a delivery attempt may change. */
export type ChannelOutcomePatch = Partial<
  Pick<
    HouseholdChannelRecord,
    | 'status'
    | 'disabledReason'
    | 'consecutiveFailures'
    | 'consecutiveClientErrors'
    | 'nextAttemptAt'
    | 'lastFailure'
    | 'lastDeliveredAt'
    | 'lastTestAt'
    | 'updatedAt'
  >
>;

/**
 * Record what a delivery did — but only against the SAME address it was made
 * with. If an admin replaced the webhook (new `urlVersion`) or disconnected it
 * while the post was in flight, the outcome belongs to an address that is
 * gone, and applying it would either resurrect a deleted row or count an old
 * URL's 404s against a new one. `stale` is that case.
 */
export async function applyOutcome(
  householdId: string,
  urlVersion: string,
  patch: ChannelOutcomePatch
): Promise<'applied' | 'stale'> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return 'applied';
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':urlVersion': urlVersion };
  const sets = entries.map(([field, value], index) => {
    names[`#f${index}`] = field;
    values[`:v${index}`] = value;
    return `#f${index} = :v${index}`;
  });
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: channelKey(householdId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK) AND urlVersion = :urlVersion',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return 'applied';
  } catch (err) {
    if (isConditionalFailure(err)) return 'stale';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Post markers — the same reserve / finalize / release lease the reminder's
// per-channel markers use (`reminders.reserveDailyReminderChannel`).
// ---------------------------------------------------------------------------

function postMarkerKey(householdId: string, kind: ChannelPostKind, periodKey: string) {
  return { PK: `HOUSEHOLD#${householdId}`, SK: `CHANNELPOST#${kind}#${periodKey}` };
}

/** Has this period's post already gone out? A live lease counts as "someone
 *  else is sending it". Throws on a failed read. */
export async function postAlreadyHandled(
  householdId: string,
  kind: ChannelPostKind,
  periodKey: string,
  now: Date
): Promise<boolean> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: postMarkerKey(householdId, kind, periodKey) })
  );
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item) return false;
  const nowEpoch = Math.floor(now.getTime() / 1000);
  if (item.status === 'sent') return true;
  return Number(item.leaseExpiresAt ?? 0) > nowEpoch;
}

/** Reserve the period's post. Null when it is already sent or leased. */
export async function reservePost(
  householdId: string,
  kind: ChannelPostKind,
  periodKey: string,
  now: Date
): Promise<string | null> {
  const reservationId = randomUUID();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...postMarkerKey(householdId, kind, periodKey),
          entityType: 'ChannelPostMarker',
          status: 'sending',
          reservationId,
          leaseExpiresAt: nowEpoch + POST_LEASE_SECONDS,
          ttl: nowEpoch + POST_MARKER_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR (#status = :sending AND leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':sending': 'sending', ':now': nowEpoch },
      })
    );
    return reservationId;
  } catch (err) {
    if (isConditionalFailure(err)) return null;
    throw err;
  }
}

/** The platform accepted the post. Never deleted on a finalize error — that
 *  would guarantee a duplicate next hour. */
export async function finalizePost(
  householdId: string,
  kind: ChannelPostKind,
  periodKey: string,
  reservationId: string,
  now: Date
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: postMarkerKey(householdId, kind, periodKey),
      UpdateExpression:
        'SET #status = :sent, sentAt = :sentAt REMOVE leaseExpiresAt, reservationId',
      ConditionExpression: '#status = :sending AND reservationId = :reservationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sent': 'sent',
        ':sending': 'sending',
        ':sentAt': now.toISOString(),
        ':reservationId': reservationId,
      },
    })
  );
}

/** The post did not land; free the period for the next hourly run. */
export async function releasePost(
  householdId: string,
  kind: ChannelPostKind,
  periodKey: string,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: postMarkerKey(householdId, kind, periodKey),
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}
