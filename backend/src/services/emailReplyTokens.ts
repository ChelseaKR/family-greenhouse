/**
 * Storage for reminder reply tokens (#667, ADR 0031).
 *
 * One row per reminder email that carried a reply address:
 *
 *   PK = EMAILREPLY#<scrypt digest of the token>   SK = TOKEN
 *
 * keyed by the digest from the shared at-rest helper (`utils/tokenHash.ts`,
 * surface `emailReply`), with NO plaintext anywhere on the row. A table
 * export yields digests, and a digest is not a reply address: the inbound
 * path hashes what it is handed, so a digest presented as a token hashes to a
 * key that does not exist. There is no legacy plaintext generation of this
 * surface, so unlike plant tags there is no fallback read to guard.
 *
 * ## What a row grants
 *
 * Exactly what the email it was minted for showed: the listed tasks, each
 * pinned to the occurrence (`expectedNextDue`) the email described, for one
 * member of one household, until `expiresAt`. The inbound path can complete
 * or snooze those tasks and nothing else — it never reads a task id from the
 * message, only a position in this list.
 *
 * ## Single use
 *
 * Per task, by construction rather than by a flag: every action passes the
 * stored `expectedNextDue` to `taskService`, whose conditional write refuses
 * any occurrence other than that one. The first action moves `nextDue`, so a
 * second action on the same task through the same token — a replayed
 * message, a second reply, a snooze after a done — can never match again.
 *
 * ## Bounded replies
 *
 * `repliesSent` caps how much mail one token can ever cause (`claimReplySend`),
 * which is what bounds a replayed DKIM-signed reply: each replay is a new SES
 * message id, applies nothing, and is still one reply closer to the cap. The
 * help, expired and unverified notices are also at most once per token each.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { hashCapabilityToken } from '../utils/tokenHash.js';
import { newReplyToken } from './email/replyAddress.js';

/**
 * How long a reply address works. A daily reminder is superseded by the next
 * morning's, and every task in it is pinned to its occurrence anyway, so this
 * only needs to cover "I read it on my phone and replied at the weekend".
 */
export const REPLY_TOKEN_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * How long an EXPIRED row is kept before DynamoDB TTL removes it, so a late
 * reply can be told its address expired instead of being met with silence.
 */
const EXPIRED_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Every reply one token can cause, of every kind, over its whole life. A
 *  reminder lists at most 10 tasks (6 assigned + 4 unclaimed), so this is one
 *  confirmation per listed task plus the three one-off notices. */
export const MAX_REPLIES_PER_TOKEN = 13;

const TOKEN_SK = 'TOKEN';
const MAX_TASKS_PER_TOKEN = 20;

export type ReplyLocale = 'en' | 'es';

export interface ReplyTokenTask {
  taskId: string;
  /** The occurrence the email described. The only one the reply may act on. */
  expectedNextDue: string;
}

export interface ReplyTokenRecord {
  digest: string;
  userId: string;
  householdId: string;
  locale: ReplyLocale;
  /** IANA zone the confirmation's dates are written in (the reminder's). */
  timeZone: string;
  /** Position i is the task the email numbered i + 1. */
  tasks: ReplyTokenTask[];
  /** Epoch seconds. */
  expiresAt: number;
}

function key(digest: string) {
  return { PK: `EMAILREPLY#${digest}`, SK: TOKEN_SK };
}

export function digestOf(token: string): string {
  return hashCapabilityToken('emailReply', token);
}

export type MintResult =
  { status: 'ok'; token: string } | { status: 'unavailable'; reason: string };

/**
 * Issue a reply token for one reminder email. The caller falls back to the
 * ordinary Reply-To (and to the email without the reply hint) on anything but
 * `ok`, so a failed mint costs the feature for one email and nothing else.
 */
export async function mintReplyToken(
  input: Omit<ReplyTokenRecord, 'digest' | 'expiresAt'>,
  now: Date = new Date()
): Promise<MintResult> {
  if (input.tasks.length === 0 || input.tasks.length > MAX_TASKS_PER_TOKEN) {
    return { status: 'unavailable', reason: 'task_count' };
  }
  const token = newReplyToken();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const expiresAt = nowEpoch + REPLY_TOKEN_TTL_SECONDS;
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...key(digestOf(token)),
          entityType: 'EmailReplyToken',
          userId: input.userId,
          householdId: input.householdId,
          locale: input.locale,
          timeZone: input.timeZone,
          tasks: input.tasks.map((t) => ({ taskId: t.taskId, expectedNextDue: t.expectedNextDue })),
          createdAt: now.toISOString(),
          expiresAt,
          repliesSent: 0,
          ttl: expiresAt + EXPIRED_RETENTION_SECONDS,
        },
        // 160 random bits will not collide; the condition makes that a checked
        // fact rather than a probability, at no cost.
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return { status: 'ok', token };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId: input.householdId, userId: input.userId },
      'email_reply.mint_failed'
    );
    return { status: 'unavailable', reason: 'write_failed' };
  }
}

export type ReadResult =
  { status: 'found'; record: ReplyTokenRecord } | { status: 'missing' } | { status: 'malformed' };

function isTaskList(value: unknown): value is ReplyTokenTask[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_TASKS_PER_TOKEN &&
    value.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as ReplyTokenTask).taskId === 'string' &&
        typeof (t as ReplyTokenTask).expectedNextDue === 'string'
    )
  );
}

/**
 * Resolve a presented token. A read FAILURE throws: the inbound Lambda is
 * invoked asynchronously, so a throw is a retry (and, past the retries, a
 * dead-letter entry) — never an answer. `missing` means no such token was
 * issued; `malformed` means a row exists that this code cannot trust, which is
 * treated exactly like `missing` (no action, no reply) but logged apart.
 */
export async function readReplyToken(token: string): Promise<ReadResult> {
  const digest = digestOf(token);
  const result = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: key(digest) }));
  const item = result.Item;
  if (!item) return { status: 'missing' };
  const locale = item.locale === 'es' ? 'es' : item.locale === 'en' ? 'en' : null;
  if (
    typeof item.userId !== 'string' ||
    typeof item.householdId !== 'string' ||
    typeof item.timeZone !== 'string' ||
    typeof item.expiresAt !== 'number' ||
    locale === null ||
    !isTaskList(item.tasks)
  ) {
    return { status: 'malformed' };
  }
  return {
    status: 'found',
    record: {
      digest,
      userId: item.userId,
      householdId: item.householdId,
      locale,
      timeZone: item.timeZone,
      tasks: item.tasks,
      expiresAt: item.expiresAt,
    },
  };
}

export type ReplySendKind = 'outcome' | 'help' | 'expired' | 'unverified';

/** The attribute that makes a kind once-per-token; `outcome` has none. */
const ONCE_ATTRIBUTE: Record<ReplySendKind, string | null> = {
  outcome: null,
  help: 'helpSentAt',
  expired: 'expiredNoticeSentAt',
  unverified: 'unverifiedNoticeSentAt',
};

/**
 * Reserve one reply against the token's budget. `help`, `expired` and
 * `unverified` are additionally once-per-token each. `exhausted` means the
 * caller sends nothing; other failures throw (and are retried).
 */
export async function claimReplySend(
  digest: string,
  kind: ReplySendKind,
  now: Date = new Date()
): Promise<'claimed' | 'exhausted'> {
  const onceAttribute = ONCE_ATTRIBUTE[kind];
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key(digest),
        UpdateExpression: onceAttribute
          ? 'SET repliesSent = repliesSent + :one, #once = :now'
          : 'SET repliesSent = repliesSent + :one',
        ConditionExpression: onceAttribute
          ? 'attribute_exists(PK) AND repliesSent < :max AND attribute_not_exists(#once)'
          : 'attribute_exists(PK) AND repliesSent < :max',
        ...(onceAttribute ? { ExpressionAttributeNames: { '#once': onceAttribute } } : {}),
        ExpressionAttributeValues: {
          ':one': 1,
          ':max': MAX_REPLIES_PER_TOKEN,
          ...(onceAttribute ? { ':now': now.toISOString() } : {}),
        },
      })
    );
    return 'claimed';
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'exhausted';
    throw err;
  }
}

/**
 * Give back a slot whose send threw, so the retry that follows the throw can
 * still send it (otherwise a one-off notice lost to an SES blip is lost for
 * good). Guarded on the counter being positive; never goes below zero.
 */
export async function releaseReplySend(digest: string, kind: ReplySendKind): Promise<void> {
  const onceAttribute = ONCE_ATTRIBUTE[kind];
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key(digest),
      UpdateExpression: onceAttribute
        ? 'SET repliesSent = repliesSent - :one REMOVE #once'
        : 'SET repliesSent = repliesSent - :one',
      ConditionExpression: 'attribute_exists(PK) AND repliesSent > :zero',
      ...(onceAttribute ? { ExpressionAttributeNames: { '#once': onceAttribute } } : {}),
      ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
    })
  );
}

// ---------------------------------------------------------------------------
// Inbound message claim — the same leased-claim shape as handlers/emailEvents
// ---------------------------------------------------------------------------

/** SES redelivers an async invoke on failure; a claim stops the same message
 *  being answered twice. Leased, so a crashed attempt does not tombstone it. */
const MESSAGE_LEASE_SECONDS = 5 * 60;
const MESSAGE_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;

function messageKey(sesMessageId: string) {
  return { PK: `EMAILREPLYMSG#${sesMessageId}`, SK: 'MESSAGE' };
}

export type MessageClaim = { kind: 'claimed'; reservationId: string } | { kind: 'duplicate' };

export async function claimInboundMessage(
  sesMessageId: string,
  reservationId: string,
  now: Date = new Date()
): Promise<MessageClaim> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...messageKey(sesMessageId),
          entityType: 'EmailReplyMessageMarker',
          status: 'processing',
          reservationId,
          leaseExpiresAt: nowEpoch + MESSAGE_LEASE_SECONDS,
          ttl: nowEpoch + MESSAGE_MARKER_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR (#status = :processing AND leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':processing': 'processing', ':now': nowEpoch },
      })
    );
    return { kind: 'claimed', reservationId };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { kind: 'duplicate' };
    }
    throw err;
  }
}

export async function finalizeInboundMessage(
  sesMessageId: string,
  reservationId: string,
  disposition: string,
  now: Date = new Date()
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: messageKey(sesMessageId),
      UpdateExpression:
        'SET #status = :done, disposition = :disposition, processedAt = :now REMOVE leaseExpiresAt, reservationId',
      ConditionExpression: '#status = :processing AND reservationId = :reservationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':done': 'done',
        ':processing': 'processing',
        ':disposition': disposition,
        ':now': now.toISOString(),
        ':reservationId': reservationId,
      },
    })
  );
}

export async function releaseInboundMessage(
  sesMessageId: string,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: messageKey(sesMessageId),
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}
