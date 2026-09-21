/**
 * DynamoDB store for outbound webhook subscriptions.
 *
 * Key layout:
 *   PK: HOUSEHOLD#{householdId}
 *   SK: WEBHOOK#{webhookId}
 *   GSI1PK: HOUSEHOLD_WEBHOOKS  (sparse — only households with webhooks)
 *   GSI1SK: HOUSEHOLD#{householdId}
 *   entityType: WebhookSubscription
 *
 * The sparse GSI1 lets the hourly dispatcher find all active webhooks
 * without scanning the table. The row lives in the household's own
 * partition, so account erasure removes it with everything else.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  type WebhookSubscription,
  type WebhookEvent,
  type WebhookFailure,
  type DeliveryFailureKind,
  backoffMs,
  WEBHOOK_MAX_CLIENT_ERRORS,
  WEBHOOK_MAX_FAILURES,
} from '../models/webhookSubscription.js';

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'family-greenhouse';

const client = new DynamoDBClient({});

// --- CRUD ---

/** Create a new webhook subscription. */
export async function createWebhook(
  webhook: Omit<
    WebhookSubscription,
    | 'createdAt'
    | 'updatedAt'
    | 'consecutiveFailures'
    | 'consecutiveClientErrors'
    | 'nextAttemptAt'
    | 'lastFailure'
    | 'lastDeliveredAt'
  >
): Promise<WebhookSubscription> {
  const now = new Date().toISOString();
  const record: WebhookSubscription = {
    ...webhook,
    consecutiveFailures: 0,
    consecutiveClientErrors: 0,
    nextAttemptAt: null,
    lastFailure: null,
    lastDeliveredAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await client.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(record as unknown as Record<string, unknown>),
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );

  return record;
}

/** Get a webhook subscription by ID. */
export async function getWebhook(
  householdId: string,
  webhookId: string
): Promise<WebhookSubscription | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `HOUSEHOLD#${householdId}`,
        SK: `WEBHOOK#${webhookId}`,
      }),
    })
  );

  if (!result.Item) return null;
  return unmarshall(result.Item) as unknown as WebhookSubscription;
}

/** List all webhook subscriptions for a household. */
export async function listWebhooks(householdId: string): Promise<WebhookSubscription[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: marshall({
        ':pk': `HOUSEHOLD#${householdId}`,
        ':skPrefix': 'WEBHOOK#',
      }),
    })
  );

  return (result.Items || []).map((item) => unmarshall(item) as unknown as WebhookSubscription);
}

/** Update an existing webhook subscription. */
export async function updateWebhook(record: WebhookSubscription): Promise<void> {
  const now = new Date().toISOString();
  const updated = { ...record, updatedAt: now };

  await client.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(updated as unknown as Record<string, unknown>),
      ConditionExpression: 'updatedAt = :expected',
      ExpressionAttributeValues: marshall({
        ':expected': record.updatedAt,
      }),
    })
  );
}

/** Delete a webhook subscription. */
export async function deleteWebhook(householdId: string, webhookId: string): Promise<void> {
  await client.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `HOUSEHOLD#${householdId}`,
        SK: `WEBHOOK#${webhookId}`,
      }),
    })
  );
}

// --- Failure Tracking ---

/** Compute the failure patch after a delivery attempt. */
export function failurePatch(
  record: WebhookSubscription,
  attempt: { kind: DeliveryFailureKind; httpStatus?: number; retryAfterSeconds?: number | null },
  now: string
): {
  consecutiveFailures: number;
  consecutiveClientErrors: number;
  nextAttemptAt: string | null;
  lastFailure: WebhookFailure;
  status?: 'disabled';
  disabledReason?: string;
} {
  const failures = record.consecutiveFailures + 1;
  const refusal = attempt.kind === 'client' || attempt.kind === 'redirect';
  const clientErrors = refusal
    ? record.consecutiveClientErrors + 1
    : attempt.kind === 'rate_limited'
      ? record.consecutiveClientErrors
      : 0;

  let disabledReason: string | null = null;
  if (attempt.kind === 'blocked') {
    disabledReason = 'blocked_address';
  } else if (refusal && clientErrors >= WEBHOOK_MAX_CLIENT_ERRORS) {
    disabledReason = 'repeated_client_errors';
  } else if (failures >= WEBHOOK_MAX_FAILURES) {
    disabledReason = 'repeated_failures';
  }

  const patch: ReturnType<typeof failurePatch> = {
    consecutiveFailures: failures,
    consecutiveClientErrors: clientErrors,
    nextAttemptAt: new Date(
      Date.now() + backoffMs(failures, attempt.retryAfterSeconds)
    ).toISOString(),
    lastFailure: {
      at: now,
      kind: attempt.kind,
      httpStatus: attempt.httpStatus ?? null,
    },
  };

  if (disabledReason) {
    patch.status = 'disabled';
    patch.disabledReason = disabledReason;
  }

  return patch;
}

/** Compute the success patch (reset all failure counters). */
export function successPatch(now: string): {
  consecutiveFailures: 0;
  consecutiveClientErrors: 0;
  nextAttemptAt: null;
  lastFailure: null;
  lastDeliveredAt: string;
  status: 'active';
} {
  return {
    consecutiveFailures: 0,
    consecutiveClientErrors: 0,
    nextAttemptAt: null,
    lastFailure: null,
    lastDeliveredAt: now,
    status: 'active',
  };
}

// --- Dispatcher Queries ---

/** Get all active webhooks that are due for delivery (for the hourly dispatcher). */
export async function getDueWebhooks(): Promise<WebhookSubscription[]> {
  const now = new Date().toISOString();

  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression:
        'GSI1PK = :gsi1pk AND #status = :active AND (attribute_not_exists(nextAttemptAt) OR nextAttemptAt <= :now)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':gsi1pk': 'HOUSEHOLD_WEBHOOKS',
        ':active': 'active',
        ':now': now,
      }),
      ProjectionExpression: 'PK, SK, householdId, id, url, host, last4, events, secret, #status',
    })
  );

  return (result.Items || []).map((item) => unmarshall(item) as unknown as WebhookSubscription);
}

/** Get webhooks subscribed to a specific event. */
export async function getWebhooksForEvent(event: WebhookEvent): Promise<WebhookSubscription[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'GSI1PK = :gsi1pk AND #status = :active AND contains(events, :event)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':gsi1pk': 'HOUSEHOLD_WEBHOOKS',
        ':active': 'active',
        ':event': event,
      }),
    })
  );

  return (result.Items || []).map((item) => unmarshall(item) as unknown as WebhookSubscription);
}
