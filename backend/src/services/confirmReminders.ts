/**
 * One automatic reminder for an account that signed up and never confirmed its
 * email address.
 *
 * ## What happened before this existed
 *
 * A self-service sign-up lands in Cognito as `UNCONFIRMED` and gets one email
 * with a six-digit code (the pool's `verification_message_template`,
 * infrastructure/modules/auth/main.tf). That code is valid for 24 hours.
 * Cognito never expires or deletes the account: it stays `UNCONFIRMED` forever,
 * it cannot sign in, and the address cannot register again (`SignUp` answers
 * `UsernameExistsException`). Nothing in this product ever contacted the
 * person again. The funnel measurement of 2026-09-13 found 2 of 3 real sign-ups
 * since 2026-09-01 stopped exactly there.
 *
 * ## The decision this implements
 *
 * Send ONE reminder, carrying a fresh code. Unconfirmed accounts are NOT let
 * into the app first; that trade-off was ruled out for a product that takes
 * payments.
 *
 * ## When
 *
 * Between `REMIND_AFTER_MS` (24h) and `REMIND_BEFORE_MS` (7 days) after
 * sign-up, on the hourly `reminders` schedule.
 *
 *   - 24 hours is when the original code stops working. Reminding earlier
 *     sends a second code while the first is still valid in the person's
 *     inbox. At 24h the original email can no longer finish the job, so the
 *     reminder is the only way forward.
 *   - 7 days is the ceiling. Past a week an unprompted email about a sign-up is
 *     likelier to be reported as spam (a complaint suppresses the address and
 *     costs the whole domain reputation, password resets included), and the
 *     ceiling bounds the catch-up burst if this pass was broken for a while.
 *
 * ## Exactly once
 *
 * The auth handler writes one row per sign-up (services/signupConfirmRecord.ts).
 * Before sending, this pass CLAIMS the row with a conditional update
 * (`attribute_not_exists(reminder)`). DynamoDB evaluates that condition
 * atomically, so of any number of concurrent runs, EventBridge retries or
 * redeploys, exactly one can claim a row. The claim is written BEFORE the send:
 * a crash between the two leaves a claimed row that is never retried. That
 * trades a possible missed reminder for a guarantee that nobody gets two.
 *
 * The one case that releases a claim is a Cognito throttle
 * (`LimitExceededException` / `TooManyRequestsException`). Those refuse the
 * request itself, so no email left, and a later run may try again.
 *
 * ## Who is never emailed
 *
 *   - An account with no sign-up row. Rows are written only by the sign-up
 *     path that ships with this change, so every account created before it
 *     ships is excluded structurally, not by a date constant.
 *   - An account that is not `UNCONFIRMED` in Cognito at send time (confirmed,
 *     admin-created, force-change-password), is disabled, or already has a
 *     verified email.
 *   - A deleted account (`UserNotFoundException`).
 *   - A post-deploy smoke-test fixture. The smoke run writes
 *     `TESTFIXTURE_SIGNUP#<sha256 of the address>` BEFORE it submits the public
 *     sign-up form (frontend/tests/e2e/post-deploy-smoke-support.ts), so there
 *     is no moment in which a fixture account exists unmarked. It is matched
 *     by that structural row, never by a name or an address pattern.
 *   - An address on the application suppression list (services/
 *     emailSuppression.ts) or on the SES account-level suppression list. The
 *     second matters here specifically: Cognito sends through SES with no
 *     configuration set, so a bounce of the ORIGINAL confirmation email never
 *     reaches the application list. It lands only on the account list.
 *
 * A lookup that FAILS (as opposed to answering) skips the account for this run
 * without settling it, so the next run asks again. "Could not check" is never
 * treated as "checked and fine".
 *
 * ## Measurement without tracking
 *
 * Two aggregate CloudWatch counts, emitted in Embedded Metric Format on the run
 * summary line: reminders sent, and accounts that confirmed within
 * `FOLLOW_UP_MS` of their reminder. The email carries no tracking pixel and no
 * redirect link. No email address, name or Cognito id is logged; the only
 * identifier stored is the opaque `sub` on the sign-up row, which expires.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  AdminGetUserCommand,
  ResendConfirmationCodeCommand,
  type AdminGetUserCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSuppressedDestinationCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cognito, CLIENT_ID, USER_POOL_ID } from '../utils/cognito.js';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { checkAddress, normalizeAddress } from './emailSuppression.js';
import { ROW_TTL_SECONDS, SIGNUP_PARTITION, SIGNUP_SORT_PREFIX } from './signupConfirmRecord.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The original code's validity. See the header for why the reminder waits for it. */
export const REMIND_AFTER_MS = 24 * HOUR_MS;

/** No reminder for a sign-up older than this. See the header. */
export const REMIND_BEFORE_MS = 7 * DAY_MS;

/** How long after a reminder a confirmation still counts toward the metric. */
export const FOLLOW_UP_MS = 7 * DAY_MS;

/** Reserved before the deadline for the summary line. */
const WIND_DOWN_MS = 1_500;

/**
 * Partition prefix of the smoke-fixture marker. Written by
 * frontend/tests/e2e/post-deploy-smoke-support.ts (`TEST_FIXTURE.signupAddressPrefix`).
 * Both workspaces pin the same key for the same synthetic address, so the two
 * cannot drift apart without a test failing.
 */
export const SIGNUP_FIXTURE_PREFIX = 'TESTFIXTURE_SIGNUP#';

/**
 * Passed to Cognito as ClientMetadata. The CustomMessage trigger
 * (infrastructure/modules/email/lambda/cognitoMessages.mjs) reads it to render
 * the reminder copy instead of the welcome copy. It is only a switch: no value
 * from it is ever interpolated into the email.
 */
export const REMINDER_CLIENT_METADATA = { purpose: 'confirm-reminder' } as const;

export const METRIC_NAMESPACE = 'FamilyGreenhouse/SignupConfirmation';
export const METRIC_REMINDERS_SENT = 'ConfirmRemindersSent';
export const METRIC_CONFIRMED_AFTER_REMINDER = 'ConfirmedAfterReminder';

/** Where a row ended up. Absent means "never processed". */
export type ReminderState =
  | 'claimed'
  | 'sent'
  | 'skipped_not_unconfirmed'
  | 'skipped_deleted'
  | 'skipped_fixture'
  | 'skipped_suppressed'
  | 'not_sent'
  | 'send_unknown';

export interface SignupRow {
  PK: string;
  SK: string;
  userSub: string;
  signedUpAt: string;
  reminder?: ReminderState;
  claimId?: string;
  remindedAt?: string;
  outcome?: 'confirmed' | 'deleted';
}

export interface ConfirmReminderRunSummary {
  /** Rows inside the [24h, 7d] window that had never been processed. */
  due: number;
  sent: number;
  confirmedAfterReminder: number;
  skippedNotUnconfirmed: number;
  skippedDeleted: number;
  skippedFixture: number;
  skippedSuppressed: number;
  /** Another run claimed the row first. */
  alreadyClaimed: number;
  /** A lookup failed; the row stays unprocessed for the next run. */
  deferred: number;
  /** Cognito throttled the send; the claim was released for the next run. */
  throttled: number;
  /** The send's outcome is unknown. Never retried. */
  failed: number;
  /** A row threw outside the send (a read or a write). Counted, never fatal. */
  errors: number;
  truncated: boolean;
}

/**
 * The key of the smoke-fixture marker for an address. The address is hashed so
 * the operator's smoke mailbox is never stored in the table, and normalised
 * exactly as the suppression list normalises it.
 */
export function signupFixtureMarkerKey(email: string): { PK: string; SK: string } {
  const digest = createHash('sha256').update(normalizeAddress(email)).digest('hex');
  return { PK: `${SIGNUP_FIXTURE_PREFIX}${digest}`, SK: 'METADATA' };
}

type UserAttributes = Record<string, string>;

function attributesOf(user: AdminGetUserCommandOutput): UserAttributes {
  const out: UserAttributes = {};
  for (const attribute of user.UserAttributes ?? []) {
    if (attribute.Name && typeof attribute.Value === 'string') {
      out[attribute.Name] = attribute.Value;
    }
  }
  return out;
}

/** Cognito states that can never become remindable, so a row can be settled. */
function permanentlyIneligible(
  user: Pick<AdminGetUserCommandOutput, 'UserStatus' | 'Enabled'>,
  attributes: UserAttributes
): boolean {
  return (
    user.UserStatus !== 'UNCONFIRMED' ||
    user.Enabled === false ||
    attributes.email_verified === 'true' ||
    !attributes.email
  );
}

/**
 * Whether Cognito's view of the account allows a reminder at all. Pure, so the
 * status rule is testable on its own: ONLY a self-service `UNCONFIRMED`
 * account, enabled, with an unverified email, created at least 24 hours ago.
 */
export function cognitoAllowsReminder(
  user: Pick<AdminGetUserCommandOutput, 'UserStatus' | 'Enabled' | 'UserCreateDate'>,
  attributes: UserAttributes,
  now: Date
): boolean {
  if (permanentlyIneligible(user, attributes)) return false;
  const created = user.UserCreateDate instanceof Date ? user.UserCreateDate.getTime() : NaN;
  if (Number.isNaN(created)) return false;
  return now.getTime() - created >= REMIND_AFTER_MS;
}

/** True when the sign-up time sits inside the reminder window. */
export function insideReminderWindow(signedUpAt: string, now: Date): boolean {
  const at = Date.parse(signedUpAt);
  if (Number.isNaN(at)) return false;
  const age = now.getTime() - at;
  return age >= REMIND_AFTER_MS && age <= REMIND_BEFORE_MS;
}

async function queryPartition(from: string, to: string): Promise<SignupRow[]> {
  const rows: SignupRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': SIGNUP_PARTITION, ':from': from, ':to': to },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of page.Items ?? []) rows.push(item as SignupRow);
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return rows;
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string }).name === 'ConditionalCheckFailedException';
}

/**
 * Settle an UNPROCESSED row without sending (`skipped_*`). Conditional on the
 * row still being unprocessed, so it can never overwrite a concurrent claim.
 */
async function settleUnprocessed(row: SignupRow, state: ReminderState, now: Date): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: row.PK, SK: row.SK },
        UpdateExpression: 'SET #reminder = :state, #settledAt = :now',
        ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#reminder)',
        ExpressionAttributeNames: {
          '#reminder': 'reminder',
          '#settledAt': 'settledAt',
          '#pk': 'PK',
        },
        ExpressionAttributeValues: { ':state': state, ':now': now.toISOString() },
      })
    );
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
}

/**
 * THE exactly-once gate: the reminded-at record, written before the send.
 * Returns the claim id when this run owns the row, or null when any other run
 * got there first.
 */
async function claimRow(row: SignupRow, now: Date): Promise<string | null> {
  const claimId = randomUUID();
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: row.PK, SK: row.SK },
        UpdateExpression: 'SET #reminder = :claimed, #claimId = :claimId, #claimedAt = :now',
        ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#reminder)',
        ExpressionAttributeNames: {
          '#reminder': 'reminder',
          '#claimId': 'claimId',
          '#claimedAt': 'claimedAt',
          '#pk': 'PK',
        },
        ExpressionAttributeValues: {
          ':claimed': 'claimed',
          ':claimId': claimId,
          ':now': now.toISOString(),
        },
      })
    );
    return claimId;
  } catch (err) {
    if (isConditionFailure(err)) return null;
    throw err;
  }
}

/** Record what happened to a send this run claimed. Conditional on owning the claim. */
async function finishClaim(
  row: SignupRow,
  claimId: string,
  state: ReminderState,
  now: Date
): Promise<void> {
  const timeField = state === 'sent' ? 'remindedAt' : 'settledAt';
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'SET #reminder = :state, #time = :now',
      ConditionExpression: '#claimId = :claimId',
      ExpressionAttributeNames: {
        '#reminder': 'reminder',
        '#time': timeField,
        '#claimId': 'claimId',
      },
      ExpressionAttributeValues: {
        ':state': state,
        ':now': now.toISOString(),
        ':claimId': claimId,
      },
    })
  );
}

/** Hand a throttled claim back so a later run may try. Only the owner may. */
async function releaseClaim(row: SignupRow, claimId: string): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'REMOVE #reminder, #claimId, #claimedAt',
      ConditionExpression: '#claimId = :claimId',
      ExpressionAttributeNames: {
        '#reminder': 'reminder',
        '#claimId': 'claimId',
        '#claimedAt': 'claimedAt',
      },
      ExpressionAttributeValues: { ':claimId': claimId },
    })
  );
}

let sesv2: SESv2Client | undefined;
function sesClient(): SESv2Client {
  sesv2 ??= new SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' });
  return sesv2;
}

type Lookup = 'clear' | 'excluded' | 'unknown';

/** Is this address a post-deploy smoke fixture? */
async function fixtureLookup(email: string): Promise<Lookup> {
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: signupFixtureMarkerKey(email) })
    );
    return result.Item ? 'excluded' : 'clear';
  } catch {
    return 'unknown';
  }
}

/** Both suppression lists. Any failed lookup is `unknown`, never `clear`. */
async function suppressionLookup(email: string): Promise<Lookup> {
  const application = await checkAddress(email);
  if (application.status === 'suppressed') return 'excluded';
  if (application.status === 'unknown') return 'unknown';
  try {
    await sesClient().send(
      new GetSuppressedDestinationCommand({ EmailAddress: normalizeAddress(email) })
    );
    // A 200 means SES holds a suppression record for the address.
    return 'excluded';
  } catch (err) {
    return (err as { name?: string }).name === 'NotFoundException' ? 'clear' : 'unknown';
  }
}

async function getUser(userSub: string): Promise<AdminGetUserCommandOutput | 'deleted'> {
  try {
    return await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: userSub })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'UserNotFoundException') return 'deleted';
    throw err;
  }
}

const THROTTLE_ERRORS = new Set(['LimitExceededException', 'TooManyRequestsException']);
const NOT_SENT_ERRORS = new Set(['InvalidParameterException', 'UserNotFoundException']);

type SendResult = 'sent' | 'throttled' | 'not_sent' | 'send_unknown';

async function sendReminder(username: string): Promise<SendResult> {
  try {
    await cognito.send(
      new ResendConfirmationCodeCommand({
        ClientId: CLIENT_ID,
        Username: username,
        ClientMetadata: { ...REMINDER_CLIENT_METADATA },
      })
    );
    return 'sent';
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (THROTTLE_ERRORS.has(name)) return 'throttled';
    // Confirmed in the moment between the status read and the send, or
    // deleted: Cognito refused, so nothing went out.
    if (NOT_SENT_ERRORS.has(name)) return 'not_sent';
    return 'send_unknown';
  }
}

/** One row inside the window that has never been processed. */
async function processDueRow(
  row: SignupRow,
  now: Date,
  summary: ConfirmReminderRunSummary
): Promise<void> {
  const user = await getUser(row.userSub);
  if (user === 'deleted') {
    summary.skippedDeleted += 1;
    await settleUnprocessed(row, 'skipped_deleted', now);
    return;
  }
  const attributes = attributesOf(user);
  if (!cognitoAllowsReminder(user, attributes, now)) {
    summary.skippedNotUnconfirmed += 1;
    // An account still under 24h old by Cognito's own clock is left for a
    // later run; anything else here can never become remindable.
    if (permanentlyIneligible(user, attributes)) {
      await settleUnprocessed(row, 'skipped_not_unconfirmed', now);
    }
    return;
  }
  const email = attributes.email;

  const fixture = await fixtureLookup(email);
  if (fixture === 'unknown') {
    summary.deferred += 1;
    return;
  }
  if (fixture === 'excluded') {
    summary.skippedFixture += 1;
    await settleUnprocessed(row, 'skipped_fixture', now);
    return;
  }

  const suppression = await suppressionLookup(email);
  if (suppression === 'unknown') {
    summary.deferred += 1;
    return;
  }
  if (suppression === 'excluded') {
    summary.skippedSuppressed += 1;
    await settleUnprocessed(row, 'skipped_suppressed', now);
    return;
  }

  const claimId = await claimRow(row, now);
  if (!claimId) {
    summary.alreadyClaimed += 1;
    return;
  }

  const result = await sendReminder(user.Username ?? row.userSub);
  if (result === 'throttled') {
    summary.throttled += 1;
    await releaseClaim(row, claimId);
    return;
  }
  if (result === 'sent') summary.sent += 1;
  else if (result === 'send_unknown') summary.failed += 1;
  await finishClaim(row, claimId, result, now);
}

/**
 * Count accounts that confirmed after their reminder. The conditional update
 * makes the COUNT exactly-once too: two runs can both see a confirmed account,
 * and only one of them sets `outcome`.
 */
async function followUp(
  row: SignupRow,
  now: Date,
  summary: ConfirmReminderRunSummary
): Promise<void> {
  const user = await getUser(row.userSub);
  let outcome: 'confirmed' | 'deleted' | null = null;
  if (user === 'deleted') outcome = 'deleted';
  else if (user.UserStatus === 'CONFIRMED') outcome = 'confirmed';
  if (!outcome) return;
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: row.PK, SK: row.SK },
        UpdateExpression: 'SET #outcome = :outcome, #outcomeAt = :now',
        ConditionExpression: '#reminder = :sent AND attribute_not_exists(#outcome)',
        ExpressionAttributeNames: {
          '#outcome': 'outcome',
          '#outcomeAt': 'outcomeAt',
          '#reminder': 'reminder',
        },
        ExpressionAttributeValues: {
          ':outcome': outcome,
          ':now': now.toISOString(),
          ':sent': 'sent',
        },
      })
    );
    if (outcome === 'confirmed') summary.confirmedAfterReminder += 1;
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
}

function needsFollowUp(row: SignupRow, now: Date): boolean {
  if (row.reminder !== 'sent' || row.outcome) return false;
  const remindedAt = Date.parse(row.remindedAt ?? '');
  return !Number.isNaN(remindedAt) && now.getTime() - remindedAt <= FOLLOW_UP_MS;
}

function emptySummary(): ConfirmReminderRunSummary {
  return {
    due: 0,
    sent: 0,
    confirmedAfterReminder: 0,
    skippedNotUnconfirmed: 0,
    skippedDeleted: 0,
    skippedFixture: 0,
    skippedSuppressed: 0,
    alreadyClaimed: 0,
    deferred: 0,
    throttled: 0,
    failed: 0,
    errors: 0,
    truncated: false,
  };
}

/**
 * The hourly pass. Rows are processed one at a time: the volume is a handful
 * of sign-ups a day, and serial processing keeps Cognito's per-account send
 * limits and the SES rate out of the picture.
 *
 * A failure on one row is counted and never stops the others. A failure to
 * read the window at all throws, so the caller reports the pass as unknown
 * rather than as a quiet hour.
 */
export async function runConfirmReminders(
  now: Date = new Date(),
  options: { deadlineAt?: number } = {}
): Promise<ConfirmReminderRunSummary> {
  const summary = emptySummary();
  const oldest = new Date(now.getTime() - ROW_TTL_SECONDS * 1000).toISOString();
  const rows = await queryPartition(
    `${SIGNUP_SORT_PREFIX}${oldest}`,
    `${SIGNUP_SORT_PREFIX}${now.toISOString()}￿`
  );
  const pastDeadline = () =>
    options.deadlineAt !== undefined && Date.now() >= options.deadlineAt - WIND_DOWN_MS;

  for (const row of rows) {
    if (pastDeadline()) {
      summary.truncated = true;
      break;
    }
    try {
      if (needsFollowUp(row, now)) {
        await followUp(row, now, summary);
      } else if (row.reminder === undefined && insideReminderWindow(row.signedUpAt, now)) {
        summary.due += 1;
        await processDueRow(row, now, summary);
      }
    } catch (err) {
      summary.errors += 1;
      logger.warn(
        { msg: 'confirm_reminders.row_failed', errorName: (err as Error).name },
        'confirm_reminders.row_failed'
      );
    }
  }

  logger.info(
    {
      msg: 'confirm_reminders.run_complete',
      ...summary,
      // CloudWatch Embedded Metric Format: these two aggregate counts become
      // metrics with no metric filter and no PutMetricData permission.
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [['Environment']],
            Metrics: [
              { Name: METRIC_REMINDERS_SENT, Unit: 'Count' },
              { Name: METRIC_CONFIRMED_AFTER_REMINDER, Unit: 'Count' },
            ],
          },
        ],
      },
      Environment: process.env.NODE_ENV ?? 'unknown',
      [METRIC_REMINDERS_SENT]: summary.sent,
      [METRIC_CONFIRMED_AFTER_REMINDER]: summary.confirmedAfterReminder,
    },
    'confirm_reminders.run_complete'
  );
  return summary;
}
