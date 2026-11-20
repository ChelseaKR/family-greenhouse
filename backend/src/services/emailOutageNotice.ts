/**
 * The one-time service note about the 2026-09-04 to 2026-11-19 email outage
 * (v0.24.0 to v0.53.1: every HTML email was refused by SES and every
 * household email failed to queue).
 *
 * Operator-run only, through `scripts/sendEmailOutageNotice.ts`. Nothing calls
 * it from a schedule, a webhook or a request handler. It is modelled on the
 * price-change notice (`services/priceChangeNotices.ts`): dry run by default,
 * one conditional marker per recipient so a re-run never mails anyone twice,
 * and the send goes through `emailNotifier.sendEmailAccepted`, which refuses a
 * suppressed or unknown-status address.
 *
 * ## Who gets it
 *
 * Every member of an active household whose `prefs.email` is on. "Active"
 * means the household's creator still exists in Cognito: the table also holds
 * leftover test households from May to July whose creator was deleted, and
 * they are left out. An operator can pass an explicit household allowlist
 * instead of the Cognito check. A person in two households gets one email.
 *
 * Admins of a household whose no-card Garden trial ended during the outage,
 * and which is not on a paid plan now, get one extra paragraph offering
 * another 14 days if they reply. Nothing here starts a trial; a reply is
 * handled by hand.
 *
 * ## The words
 *
 * The subject, body, sign-off and trial paragraph are the text Chelsea
 * approved on 2026-11-19, verbatim. Do not edit them here without a new
 * approval: the tests pin them character for character. English only; every
 * stored email locale on the recipient list is blank.
 *
 * ## Read-only until --confirm
 *
 * `planEmailOutageNotice` and `previewSuppression` only read (Scan, Query,
 * GetItem, Cognito AdminGetUser). Only `sendEmailOutageNotice` writes: the
 * marker, and the send itself.
 */
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { cognito, USER_POOL_ID } from '../utils/cognito.js';
import { logger } from '../utils/logger.js';
import {
  NO_CARD_TRIAL_DAYS,
  noCardTrialState,
  type EntitlementSubscription,
} from '../models/plans.js';
import type { HouseholdMember } from '../models/types.js';
import * as billing from './billing.js';
import * as householdService from './householdService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as emailNotifier from './emailNotifier.js';
import * as emailSuppression from './emailSuppression.js';
import { formatDate } from './billingEmailCopy.js';
import { t } from './email/catalog.js';
import { notificationSettingsUrl, settingsUrl } from './email/links.js';
import { renderEmail, type EmailBlock } from './email/template.js';

// ---------------------------------------------------------------------------
// Fixed facts about this notice
// ---------------------------------------------------------------------------

/** Marker partition id. One notice, sent once. */
export const NOTICE_ID = 'email-outage-2026-11';

/** The weekly digest goes out at this instant; the note must land before it. */
export const SEND_CUTOFF = '2026-11-23T00:00:00.000Z';

/** A trial that ended in [OUTAGE_START, OUTAGE_END_EXCLUSIVE) ran while email was down. */
export const OUTAGE_START = '2026-09-04T00:00:00.000Z';
export const OUTAGE_END_EXCLUSIVE = '2026-11-20T00:00:00.000Z';

/**
 * `{your name}` in the approved draft. No other operator email signs with a
 * person's name (the price-change and billing notices sign as "The Family
 * Greenhouse team", which the draft's second sign-off line already says), so
 * this is the owner's name, as the brief specified.
 */
export const SENDER_NAME = 'Chelsea';

export const FOOTER_REASON =
  'You are getting this because you have a Family Greenhouse account and our emails to you were affected.';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCALE = 'en' as const;

// ---------------------------------------------------------------------------
// The approved text (2026-11-19). Verbatim; see the module header.
// ---------------------------------------------------------------------------

export const SUBJECT = "Family Greenhouse emails were not going out. It's fixed now.";

const P_BUG =
  'A bug on our side kept most Family Greenhouse emails from sending from early September until November 19. That included care reminders, the weekly digest, and household notices like "someone covered your task." Your plants, tasks and settings were not affected.';
const P_FIXED =
  "It's fixed now, and reminders will start again at your usual time. Because nothing went out for a while, your next reminder or weekly digest may list tasks that are many days overdue. If a schedule no longer fits a plant, you can mark the task done or change how often it repeats in the app.";
const P_SETTINGS_LEAD = 'You can choose which emails you get in Settings:';
const P_SORRY =
  "Sorry about the gap. If anything looks wrong, reply to this email and I'll look into it.";
const SIGNOFF_BRAND = 'Family Greenhouse';

function trialParagraph(start: string, end: string): string {
  return `Your household's free Garden trial ran from ${start} to ${end}, while these emails were not sending. If you'd like another 14 days of Garden, reply to this email and I'll start it. There's no card involved, and when it ends your household goes back to Seedling, the free plan, on its own, with nothing deleted.`;
}

// ---------------------------------------------------------------------------
// Composing (pure)
// ---------------------------------------------------------------------------

/**
 * The name to greet, or null for the app's generic "Hi there,".
 *
 * First word of the stored member name, like the plant-tag scan page's
 * `firstName`. Null when nothing is stored, and also when the stored name is
 * just the address's local part: `cognitoUsers.getUserName` writes that as a
 * fallback for accounts without a name attribute, so it is not a name anyone
 * gave us, and "Hi jane.doe+fg," reads like a mail merge gone wrong.
 */
export function greetingName(name: string | null | undefined, email: string): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed.includes('@')) return null;
  // Exact match only: `getUserName` copies the local part as is, while a
  // person named "Sam" at sam@... typed their name with a capital.
  const localPart = email.split('@')[0]?.trim() ?? '';
  if (localPart && trimmed === localPart) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/** A trial instant as a long date in the recipient's zone, the way the billing
 *  and trial emails write dates. A zone Intl rejects falls back to UTC. */
export function formatNoticeDate(iso: string, timeZone: string): string {
  try {
    return formatDate(iso, LOCALE, timeZone) ?? formatDate(iso, LOCALE, 'UTC') ?? iso;
  } catch {
    return formatDate(iso, LOCALE, 'UTC') ?? iso;
  }
}

export interface TrialWindow {
  startedAt: string;
  endedAt: string;
}

export interface NoticeRecipientCopy {
  name: string | null | undefined;
  email: string;
  /** Present only for an admin of a household whose trial ended in the outage. */
  trial: TrialWindow | null;
  timeZone: string;
}

/** The body exactly as approved, with the placeholders filled. Used as the
 *  plain-text body and pinned by the tests. */
export function noticeBodyText(copy: NoticeRecipientCopy): string {
  const first = greetingName(copy.name, copy.email);
  const paragraphs = [
    first ? t(LOCALE, 'welcome.greeting', { name: first }) : t(LOCALE, 'welcome.greetingGeneric'),
    P_BUG,
    P_FIXED,
  ];
  if (copy.trial) {
    paragraphs.push(
      trialParagraph(
        formatNoticeDate(copy.trial.startedAt, copy.timeZone),
        formatNoticeDate(copy.trial.endedAt, copy.timeZone)
      )
    );
  }
  paragraphs.push(
    `${P_SETTINGS_LEAD} ${notificationSettingsUrl()}`,
    P_SORRY,
    `${SENDER_NAME}\n${SIGNOFF_BRAND}`
  );
  return paragraphs.join('\n\n');
}

export function composeEmailOutageNotice(copy: NoticeRecipientCopy): {
  subject: string;
  text: string;
  html: string;
} {
  const body = noticeBodyText(copy);
  const [greeting, ...rest] = body.split('\n\n');
  // The HTML twin: the same paragraphs as blocks, with the settings URL as a
  // real link and the two sign-off lines as two blocks (a text block has no
  // line breaks of its own).
  const blocks: EmailBlock[] = [{ kind: 'text', text: greeting ?? '' }];
  for (const paragraph of rest) {
    if (paragraph.startsWith(P_SETTINGS_LEAD)) {
      blocks.push({ kind: 'text', text: P_SETTINGS_LEAD });
      blocks.push({
        kind: 'link',
        label: notificationSettingsUrl(),
        href: notificationSettingsUrl(),
      });
    } else if (paragraph.includes('\n')) {
      for (const line of paragraph.split('\n')) blocks.push({ kind: 'text', text: line });
    } else {
      blocks.push({ kind: 'text', text: paragraph });
    }
  }
  const { html, text } = renderEmail(
    {
      locale: LOCALE,
      title: SUBJECT,
      // The body's own first sentence: no new words, and not the subject.
      preheader: P_BUG.slice(0, P_BUG.indexOf('.') + 1),
      blocks,
      footer: {
        reason: FOOTER_REASON,
        safety: t(LOCALE, 'footer.safety'),
        links: [{ label: t(LOCALE, 'footer.manage'), href: settingsUrl() }],
      },
    },
    { textBody: body }
  );
  return { subject: SUBJECT, text, html };
}

// ---------------------------------------------------------------------------
// Which households get the trial paragraph (pure)
// ---------------------------------------------------------------------------

/**
 * The trial window when this household's no-card trial ended during the
 * outage and the household is not on a paid plan now; null otherwise.
 *
 * `noCardTrialState` is the definition of record: it already reports `none`
 * for any Stripe state (a subscription id or status, a lifetime purchase, a
 * paid `planId`), any App Store state and a running gift, which are every
 * route to a paid plan. So `ended` already means "trial over, not paying",
 * and no plan-id comparison is added on top (the entitlement-gates check
 * forbids one). The start is derived from the end and the trial length, as
 * the trial emails do.
 */
export function endedTrialDuringOutage(
  sub: EntitlementSubscription,
  now: Date
): TrialWindow | null {
  if (!sub.noCardTrialEndsAt) return null;
  if (noCardTrialState(sub, now) !== 'ended') return null;
  const endMs = Date.parse(sub.noCardTrialEndsAt);
  if (!Number.isFinite(endMs)) return null;
  if (endMs < Date.parse(OUTAGE_START) || endMs >= Date.parse(OUTAGE_END_EXCLUSIVE)) return null;
  return {
    startedAt: new Date(endMs - NO_CARD_TRIAL_DAYS * DAY_MS).toISOString(),
    endedAt: sub.noCardTrialEndsAt,
  };
}

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

const MARKER_PK = `SERVICE_NOTICE#${NOTICE_ID}`;
const markerSk = (userId: string) => `EMAIL#${userId}`;

async function markerExists(userId: string): Promise<boolean> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: MARKER_PK, SK: markerSk(userId) } })
  );
  return Boolean(result.Item);
}

async function claim(userId: string, now: Date): Promise<boolean> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: MARKER_PK,
          SK: markerSk(userId),
          entityType: 'ServiceNoticeMarker',
          sentAt: now.toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Undo a claim when nothing left, so a re-run retries this person. */
async function release(userId: string): Promise<void> {
  await dynamodb
    .send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: MARKER_PK, SK: markerSk(userId) } })
    )
    .catch((err) => {
      logger.warn({ err: (err as Error).message }, 'email_outage_notice_release_failed');
    });
}

// ---------------------------------------------------------------------------
// Planning (read-only)
// ---------------------------------------------------------------------------

/** True when the Cognito user exists; false only on UserNotFoundException.
 *  Any other failure throws: an unreadable pool must stop the run, not
 *  quietly reclassify real households as test ones. */
export async function cognitoUserExists(userId: string): Promise<boolean> {
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: userId }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'UserNotFoundException') return false;
    throw err;
  }
}

export interface PlannedRecipient {
  userId: string;
  email: string;
  name: string;
  timeZone: string;
  trial: TrialWindow | null;
}

export interface NoticePlan {
  householdsScanned: number;
  /** Creator missing from Cognito (or no creator on the row). */
  householdsExcludedAsTest: number;
  /** Left out because an allowlist was given and did not name them. */
  householdsNotAllowlisted: number;
  /** Households whose admins get the trial paragraph. */
  householdsWithEndedTrial: number;
  recipients: PlannedRecipient[];
  skipped: { emailOff: number; noAddress: number; alreadySent: number };
}

export interface PlanOptions {
  now: Date;
  /** Household ids to consider. When given, the Cognito check is not made. */
  allowlist?: ReadonlySet<string>;
  /** Injected for tests; defaults to the Cognito lookup. */
  creatorExists?: (userId: string) => Promise<boolean>;
}

function hasAddress(member: HouseholdMember): boolean {
  return typeof member.email === 'string' && member.email.includes('@');
}

export async function planEmailOutageNotice(options: PlanOptions): Promise<NoticePlan> {
  const { now, allowlist } = options;
  const creatorExists = options.creatorExists ?? cognitoUserExists;
  const plan: NoticePlan = {
    householdsScanned: 0,
    householdsExcludedAsTest: 0,
    householdsNotAllowlisted: 0,
    householdsWithEndedTrial: 0,
    recipients: [],
    skipped: { emailOff: 0, noAddress: 0, alreadySent: 0 },
  };

  // userId -> what we know so far. One email per person, however many
  // households they are in.
  const byUser = new Map<string, { member: HouseholdMember; trial: TrialWindow | null }>();

  const householdIds = await householdService.listAllHouseholdIds();
  for (const householdId of householdIds) {
    plan.householdsScanned += 1;
    if (allowlist) {
      if (!allowlist.has(householdId)) {
        plan.householdsNotAllowlisted += 1;
        continue;
      }
    } else {
      const household = await householdService.getHousehold(householdId);
      const creator = household?.createdBy;
      if (!creator || !(await creatorExists(creator))) {
        plan.householdsExcludedAsTest += 1;
        continue;
      }
    }

    const sub = await billing.getHouseholdSubscription(householdId, now);
    const trial = endedTrialDuringOutage(sub, now);
    if (trial) plan.householdsWithEndedTrial += 1;

    const members = await householdService.getHouseholdMembers(householdId);
    for (const member of members) {
      const memberTrial = trial && member.role === 'admin' ? trial : null;
      const seen = byUser.get(member.userId);
      if (seen) {
        if (!seen.trial && memberTrial) seen.trial = memberTrial;
        continue;
      }
      byUser.set(member.userId, { member, trial: memberTrial });
    }
  }

  for (const { member, trial } of byUser.values()) {
    if (!hasAddress(member)) {
      plan.skipped.noAddress += 1;
      continue;
    }
    const prefs = await notificationPrefs.getPreferences(member.userId);
    if (!prefs.email) {
      plan.skipped.emailOff += 1;
      continue;
    }
    if (await markerExists(member.userId)) {
      plan.skipped.alreadySent += 1;
      continue;
    }
    plan.recipients.push({
      userId: member.userId,
      email: member.email,
      name: member.name,
      timeZone: prefs.timezone || 'UTC',
      trial,
    });
  }
  return plan;
}

/** Dry-run view of what the suppression check will refuse. Read-only. */
export async function previewSuppression(
  recipients: readonly PlannedRecipient[]
): Promise<{ sendable: PlannedRecipient[]; suppressed: number; suppressionUnknown: number }> {
  const sendable: PlannedRecipient[] = [];
  let suppressed = 0;
  let suppressionUnknown = 0;
  for (const recipient of recipients) {
    const status = await emailSuppression.checkAddress(recipient.email);
    if (status.status === 'suppressed') suppressed += 1;
    else if (status.status === 'unknown') suppressionUnknown += 1;
    else sendable.push(recipient);
  }
  return { sendable, suppressed, suppressionUnknown };
}

// ---------------------------------------------------------------------------
// Sending (writes)
// ---------------------------------------------------------------------------

export interface SendSummary {
  sent: number;
  sentWithTrialParagraph: number;
  /** A marker appeared between planning and sending (another run). */
  alreadySent: number;
  suppressed: number;
  suppressionUnknown: number;
  /** SES_FROM_EMAIL unset: the notifier only logged. Marker released. */
  notConfigured: number;
  /** SES threw or composing failed. Marker released, so a re-run retries. */
  failed: number;
}

export async function sendEmailOutageNotice(
  recipients: readonly PlannedRecipient[],
  options: { now: Date }
): Promise<SendSummary> {
  const summary: SendSummary = {
    sent: 0,
    sentWithTrialParagraph: 0,
    alreadySent: 0,
    suppressed: 0,
    suppressionUnknown: 0,
    notConfigured: 0,
    failed: 0,
  };
  for (const recipient of recipients) {
    if (!(await claim(recipient.userId, options.now))) {
      summary.alreadySent += 1;
      continue;
    }
    let reason: emailNotifier.EmailAcceptanceReason | 'error' = 'error';
    try {
      const { subject, text, html } = composeEmailOutageNotice(recipient);
      const result = await emailNotifier.sendEmailAccepted({
        to: recipient.email,
        subject,
        text,
        html,
      });
      reason = result.accepted ? 'sent' : result.reason;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'email_outage_notice_send_failed');
    }

    if (reason === 'sent') {
      summary.sent += 1;
      if (recipient.trial) summary.sentWithTrialParagraph += 1;
      continue;
    }
    await release(recipient.userId);
    if (reason === 'suppressed') summary.suppressed += 1;
    else if (reason === 'suppression_unknown') summary.suppressionUnknown += 1;
    else if (reason === 'dry_run') summary.notConfigured += 1;
    else summary.failed += 1;
  }
  return summary;
}
