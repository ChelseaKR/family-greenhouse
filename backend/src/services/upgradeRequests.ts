/**
 * Member → admin upgrade requests.
 *
 * Billing is `requireAdmin`, so a plain member who hits a paid feature has no
 * way to buy it. This is the only conversion path that runs INSIDE the
 * household (brief §7d): the member names the feature they hit, and every
 * admin of the household gets a real message about it — a browser/native push
 * through the normal notifier fan-out, an email through SES, and a row in the
 * household activity feed so the ask is visible in-app afterwards.
 *
 * Nothing here touches money. Members ask; admins buy through the existing
 * admin-only checkout.
 *
 * Rate limit — ONCE PER MEMBER PER FEATURE PER 7 DAYS, enforced globally in
 * DynamoDB (not the per-warm-container in-memory limiter): a marker row
 * `HOUSEHOLD#{id} / UPGRADE_REQUEST#{feature}#{userId}` is written with a
 * conditional Put that refuses while the previous marker is younger than the
 * window. The same row carries a `ttl` so DynamoDB sweeps it once the window
 * has lapsed. That bound is what keeps the marginal cost of this feature at
 * ~one SES send per admin per member per feature per week.
 *
 * The feature vocabulary, tier resolution, and message copy live in
 * models/upgradeFeatures.ts (pure) so the dev server can share them.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import {
  composeUpgradeRequestEmail,
  composeUpgradeRequestPush,
  REQUEST_WINDOW_MS,
  resolveTargetPlan,
  type PaidPlanId,
  type UpgradeFeature,
} from '../models/upgradeFeatures.js';
import type { HouseholdMember } from '../models/types.js';
import * as householdService from './householdService.js';
import * as billing from './billing.js';
import * as notifier from './notifier.js';
import * as emailNotifier from './emailNotifier.js';
import { recordActivity } from './activity.js';

export {
  UPGRADE_FEATURES,
  FEATURE_CATALOG,
  REQUEST_WINDOW_MS,
  resolveTargetPlan,
  composeUpgradeRequestEmail,
  type PaidPlanId,
  type UpgradeFeature,
} from '../models/upgradeFeatures.js';

/** Extra slack past the window before DynamoDB TTL sweeps the marker, so a
 *  request landing right at the boundary still sees the row it should. */
const TTL_BUFFER_MS = 24 * 60 * 60 * 1000;

/** A member asked again inside the 7-day window. `nextAllowedAt` is read
 *  from the stored marker; it is null only when that read could not be made,
 *  never a guessed date. */
export class UpgradeRequestRateLimitedError extends Error {
  readonly nextAllowedAt: string | null;
  constructor(nextAllowedAt: string | null) {
    super('You already asked for this recently. You can ask again once a week.');
    this.name = 'UpgradeRequestRateLimitedError';
    this.nextAllowedAt = nextAllowedAt;
  }
}

/** The household's current plan already includes the feature. */
export class UpgradeAlreadyIncludedError extends Error {
  constructor() {
    super('Your household already has this. Reload to see it.');
    this.name = 'UpgradeAlreadyIncludedError';
  }
}

/** Data anomaly: the household has no admin to ask (creation is transactional,
 *  so this should be unreachable — it is named rather than swallowed). */
export class NoHouseholdAdminError extends Error {
  constructor() {
    super('This household has no admin to ask.');
    this.name = 'NoHouseholdAdminError';
  }
}

export interface UpgradeRequestInput {
  householdId: string;
  requester: { userId: string; email: string };
  feature: UpgradeFeature;
  /** FRONTEND_URL base the links hang off (trailing slash tolerated). */
  appUrl: string;
  now?: Date;
}

export interface UpgradeRequestResult {
  feature: UpgradeFeature;
  targetPlanId: PaidPlanId;
  requestedAt: string;
  /** When this member may ask for this feature again. */
  nextAllowedAt: string;
  /** The admins who were told. Names only — never their emails. */
  admins: Array<{ userId: string; name: string }>;
  /** True when SES accepted at least one admin email. False covers both a
   *  failed send and an unconfigured sender (dry run); neither left the
   *  building, and the client is told so rather than shown a success. */
  emailDelivered: boolean;
  /** True when at least one admin's browser/native push actually went out. */
  pushDelivered: boolean;
}

function markerKey(householdId: string, feature: UpgradeFeature, userId: string) {
  return { PK: `HOUSEHOLD#${householdId}`, SK: `UPGRADE_REQUEST#${feature}#${userId}` };
}

async function readNextAllowedAt(
  householdId: string,
  feature: UpgradeFeature,
  userId: string
): Promise<string | null> {
  const existing = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: markerKey(householdId, feature, userId) })
  );
  const item = existing.Item as Record<string, unknown> | undefined;
  const epoch = item?.requestedAtEpoch;
  if (typeof epoch !== 'number') return null;
  return new Date(epoch * 1000 + REQUEST_WINDOW_MS).toISOString();
}

/**
 * Claim this member's weekly slot for `feature`. Throws
 * UpgradeRequestRateLimitedError when the previous marker is still inside the
 * window. The conditional Put is the authority; the read after a refusal only
 * exists to report an honest `nextAllowedAt`.
 */
async function claimWeeklySlot(
  householdId: string,
  feature: UpgradeFeature,
  userId: string,
  targetPlanId: PaidPlanId,
  now: Date
): Promise<void> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const cutoffEpoch = Math.floor((now.getTime() - REQUEST_WINDOW_MS) / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...markerKey(householdId, feature, userId),
          entityType: 'UpgradeRequest',
          householdId,
          userId,
          feature,
          targetPlanId,
          requestedAt: now.toISOString(),
          requestedAtEpoch: nowEpoch,
          ttl: Math.floor((now.getTime() + REQUEST_WINDOW_MS + TTL_BUFFER_MS) / 1000),
        },
        // Absent, or older than the window: a fresh ask. Anything younger is
        // refused atomically, so two concurrent taps can never both send.
        ConditionExpression: 'attribute_not_exists(PK) OR requestedAtEpoch < :cutoff',
        ExpressionAttributeValues: { ':cutoff': cutoffEpoch },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const nextAllowedAt = await readNextAllowedAt(householdId, feature, userId).catch(
        (readErr) => {
          logger.warn(
            { err: (readErr as Error).message, householdId, feature, userId },
            'upgrade_request.next_allowed_read_failed'
          );
          return null;
        }
      );
      throw new UpgradeRequestRateLimitedError(nextAllowedAt);
    }
    throw err;
  }
}

/**
 * Record the request, then tell every admin. The slot claim is the only step
 * that can refuse; everything after it is best-effort and reported truthfully
 * in the result rather than thrown, so one flaky channel never turns a
 * recorded ask into a client-side error that invites a retry the rate limit
 * would refuse.
 */
export async function requestUpgrade(input: UpgradeRequestInput): Promise<UpgradeRequestResult> {
  const now = input.now ?? new Date();
  const { householdId, feature, requester } = input;

  const [subscription, household, members] = await Promise.all([
    billing.getHouseholdSubscription(householdId),
    householdService.getHousehold(householdId),
    householdService.getHouseholdMembers(householdId),
  ]);

  const targetPlanId = resolveTargetPlan(feature, subscription.planId);
  if (!targetPlanId) throw new UpgradeAlreadyIncludedError();

  // Every admin gets the ask (a household may have several); the requester
  // is never a recipient even if their role changed mid-flight.
  const admins: HouseholdMember[] = members.filter(
    (m) => m.role === 'admin' && m.userId !== requester.userId
  );
  if (admins.length === 0) throw new NoHouseholdAdminError();

  await claimWeeklySlot(householdId, feature, requester.userId, targetPlanId, now);

  const memberName =
    members.find((m) => m.userId === requester.userId)?.name?.trim() || 'A household member';
  const householdName = household?.name?.trim() || 'your household';

  let emailDelivered = false;
  let pushDelivered = false;
  await Promise.all(
    admins.map(async (admin) => {
      const { subject, text } = composeUpgradeRequestEmail({
        adminName: admin.name,
        memberName,
        householdName,
        feature,
        targetPlanId,
        appUrl: input.appUrl,
      });
      // Email goes straight through the SES sender (like the welcome email):
      // this is a one-off household message, not a reminder, so it does not
      // sit behind the reminder email preference or the DND window.
      const emailWork = emailNotifier
        .sendEmail({ to: admin.email, subject, text })
        .then((sent) => {
          if (sent) emailDelivered = true;
        })
        .catch((err) => {
          logger.warn(
            { err: (err as Error).message, householdId, adminId: admin.userId },
            'upgrade_request.email_failed'
          );
        });
      // Push respects the admin's own browser-notification preference via the
      // normal fan-out; only the browser channel is requested so the email
      // above is not doubled through the reminder path.
      const pushWork = notifier
        .sendToUser(
          { userId: admin.userId, email: admin.email },
          composeUpgradeRequestPush({
            memberName,
            householdName,
            feature,
            targetPlanId,
            appUrl: input.appUrl,
            householdId,
          }),
          { channels: ['browser'], now }
        )
        .then((result) => {
          if (result.delivered) pushDelivered = true;
        })
        .catch((err) => {
          logger.warn(
            { err: (err as Error).message, householdId, adminId: admin.userId },
            'upgrade_request.push_failed'
          );
        });
      await Promise.all([emailWork, pushWork]);
    })
  );

  // Visible in-app afterwards, to the whole household: the ask is part of the
  // household's story, and the social pressure is the point (brief §7d).
  await recordActivity({
    type: 'upgrade.requested',
    householdId,
    actorId: requester.userId,
    actorName: memberName,
    payload: { feature, plan: targetPlanId },
  });

  logger.info(
    {
      householdId,
      feature,
      targetPlanId,
      adminCount: admins.length,
      emailDelivered,
      pushDelivered,
      msg: 'upgrade_request.sent',
    },
    'upgrade_request.sent'
  );

  return {
    feature,
    targetPlanId,
    requestedAt: now.toISOString(),
    nextAllowedAt: new Date(now.getTime() + REQUEST_WINDOW_MS).toISOString(),
    admins: admins.map((a) => ({ userId: a.userId, name: a.name })),
    emailDelivered,
    pushDelivered,
  };
}
