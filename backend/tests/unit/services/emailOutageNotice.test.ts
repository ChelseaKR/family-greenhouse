import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/utils/cognito.js', () => ({
  cognito: { send: vi.fn() },
  USER_POOL_ID: 'test-pool',
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({ sendEmailAccepted: vi.fn() }));
vi.mock('../../../src/services/emailSuppression.js', () => ({ checkAddress: vi.fn() }));
vi.mock('../../../src/services/notificationPrefs.js', () => ({ getPreferences: vi.fn() }));
vi.mock('../../../src/services/householdService.js', () => ({
  listAllHouseholdIds: vi.fn(),
  getHousehold: vi.fn(),
  getHouseholdMembers: vi.fn(),
}));
vi.mock('../../../src/services/billing.js', () => ({ getHouseholdSubscription: vi.fn() }));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import { cognito } from '../../../src/utils/cognito.js';
import * as emailNotifier from '../../../src/services/emailNotifier.js';
import * as emailSuppression from '../../../src/services/emailSuppression.js';
import * as notificationPrefs from '../../../src/services/notificationPrefs.js';
import * as householdService from '../../../src/services/householdService.js';
import * as billing from '../../../src/services/billing.js';
import {
  FOOTER_REASON,
  SUBJECT,
  cognitoUserExists,
  composeEmailOutageNotice,
  endedTrialDuringOutage,
  greetingName,
  noticeBodyText,
  planEmailOutageNotice,
  previewSuppression,
  sendEmailOutageNotice,
  type PlannedRecipient,
} from '../../../src/services/emailOutageNotice.js';
import type { HouseholdMember, Household } from '../../../src/models/types.js';
import type { HouseholdSubscription } from '../../../src/services/billing.js';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');

// ---------------------------------------------------------------------------
// The approved text, typed out from FOR-APPROVAL.md (2026-11-19), NOT built
// from the module's constants: this is the check that the module says exactly
// what was approved.
// ---------------------------------------------------------------------------

const APPROVED_SUBJECT = "Family Greenhouse emails were not going out. It's fixed now.";

function approvedBody(greeting: string, trialParagraph: string | null): string {
  return [
    greeting,
    'A bug on our side kept most Family Greenhouse emails from sending from early September until November 19. That included care reminders, the weekly digest, and household notices like "someone covered your task." Your plants, tasks and settings were not affected.',
    "It's fixed now, and reminders will start again at your usual time. Because nothing went out for a while, your next reminder or weekly digest may list tasks that are many days overdue. If a schedule no longer fits a plant, you can mark the task done or change how often it repeats in the app.",
    ...(trialParagraph ? [trialParagraph] : []),
    'You can choose which emails you get in Settings: https://familygreenhouse.net/settings?section=notifications',
    "Sorry about the gap. If anything looks wrong, reply to this email and I'll look into it.",
    'Chelsea\nFamily Greenhouse',
  ].join('\n\n');
}

const APPROVED_TRIAL_PARAGRAPH =
  "Your household's free Garden trial ran from September 17, 2026 to October 1, 2026, while these emails were not sending. If you'd like another 14 days of Garden, reply to this email and I'll start it. There's no card involved, and when it ends your household goes back to Seedling, the free plan, on its own, with nothing deleted.";

const TRIAL = { startedAt: '2026-09-17T18:00:00.000Z', endedAt: '2026-10-01T18:00:00.000Z' };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeCommand {
  kind: 'Get' | 'Put' | 'Delete';
  input: { Key?: { PK?: string; SK?: string }; Item?: Record<string, unknown> };
}

let markers: Set<string>;
let commands: FakeCommand[];

function keyOf(cmd: FakeCommand): string {
  const key = cmd.input.Key ?? {
    PK: cmd.input.Item?.PK as string,
    SK: cmd.input.Item?.SK as string,
  };
  return `${key.PK}|${key.SK}`;
}

function installFakeTable(): void {
  markers = new Set();
  commands = [];
  vi.mocked(dynamodb.send).mockImplementation(async (command: unknown) => {
    const cmd = command as FakeCommand;
    commands.push(cmd);
    const key = keyOf(cmd);
    if (cmd.kind === 'Get') return { Item: markers.has(key) ? { PK: 'x' } : undefined };
    if (cmd.kind === 'Put') {
      if (markers.has(key)) {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      markers.add(key);
      return {};
    }
    markers.delete(key);
    return {};
  });
}

function person(
  userId: string,
  role: 'admin' | 'member',
  overrides: Partial<HouseholdMember> = {}
): HouseholdMember {
  return {
    householdId: 'unused',
    userId,
    name: `Name ${userId}`,
    email: `${userId}@example.com`,
    role,
    joinedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function prefs(email: boolean): NotificationPreferences {
  return { email, timezone: 'America/Los_Angeles' } as NotificationPreferences;
}

const SEEDLING: HouseholdSubscription = { planId: 'seedling' };
const ENDED_IN_OUTAGE: HouseholdSubscription = {
  planId: 'seedling',
  noCardTrialEndsAt: TRIAL.endedAt,
};

interface World {
  households: Record<
    string,
    { creator: string | null; sub: HouseholdSubscription; members: HouseholdMember[] }
  >;
  emailOff?: string[];
  missingCreators?: string[];
}

function install(world: World): void {
  vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(Object.keys(world.households));
  vi.mocked(householdService.getHousehold).mockImplementation(async (id: string) => {
    const h = world.households[id];
    return h ? ({ id, createdBy: h.creator ?? undefined } as unknown as Household) : null;
  });
  vi.mocked(householdService.getHouseholdMembers).mockImplementation(
    async (id: string) => world.households[id]?.members ?? []
  );
  vi.mocked(billing.getHouseholdSubscription).mockImplementation(
    async (id: string) => world.households[id]?.sub ?? SEEDLING
  );
  vi.mocked(notificationPrefs.getPreferences).mockImplementation(async (userId: string) =>
    prefs(!(world.emailOff ?? []).includes(userId))
  );
  const missing = new Set(world.missingCreators ?? []);
  vi.mocked(cognito.send).mockImplementation(async (command: unknown) => {
    const username = (command as { input: { Username: string } }).input.Username;
    if (missing.has(username)) {
      const err = new Error('User does not exist.');
      err.name = 'UserNotFoundException';
      throw err;
    }
    return {};
  });
}

const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;

beforeEach(() => {
  process.env.FRONTEND_URL = 'https://familygreenhouse.net';
  installFakeTable();
  vi.mocked(emailNotifier.sendEmailAccepted).mockResolvedValue({ accepted: true, reason: 'sent' });
  vi.mocked(emailSuppression.checkAddress).mockResolvedValue({ status: 'sendable' });
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_FRONTEND_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
});

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

describe('the approved text', () => {
  it('has the approved subject', () => {
    expect(SUBJECT).toBe(APPROVED_SUBJECT);
    const { subject } = composeEmailOutageNotice({
      name: 'Sam Rivera',
      email: 'sam@example.com',
      trial: null,
      timeZone: 'UTC',
    });
    expect(subject).toBe(APPROVED_SUBJECT);
  });

  it('renders the body exactly as approved, first name filled in', () => {
    const body = noticeBodyText({
      name: 'Sam Rivera',
      email: 'sam@example.com',
      trial: null,
      timeZone: 'UTC',
    });
    expect(body).toBe(approvedBody('Hi Sam,', null));
  });

  it('adds the approved trial paragraph, dates in the recipient zone', () => {
    const body = noticeBodyText({
      name: 'Sam',
      email: 'sam@example.com',
      trial: TRIAL,
      timeZone: 'America/Los_Angeles',
    });
    expect(body).toBe(approvedBody('Hi Sam,', APPROVED_TRIAL_PARAGRAPH));
  });

  it('falls back to UTC for a zone Intl rejects', () => {
    const body = noticeBodyText({
      name: 'Sam',
      email: 'sam@example.com',
      trial: TRIAL,
      timeZone: 'Not/AZone',
    });
    expect(body).toContain('ran from September 17, 2026 to October 1, 2026,');
  });

  it('greets with the app’s generic "Hi there," when no name is stored', () => {
    expect(
      noticeBodyText({ name: '', email: 'sam@example.com', trial: null, timeZone: 'UTC' })
    ).toBe(approvedBody('Hi there,', null));
  });

  it('the plain-text part is the template frame around the exact body', () => {
    const { text } = composeEmailOutageNotice({
      name: 'Sam',
      email: 'sam@example.com',
      trial: null,
      timeZone: 'UTC',
    });
    expect(text).toBe(
      [
        APPROVED_SUBJECT,
        '='.repeat(Math.min(APPROVED_SUBJECT.length, 60)),
        '',
        approvedBody('Hi Sam,', null),
        '',
        '--',
        FOOTER_REASON,
        'Family Greenhouse will never ask for your password or payment details by email.',
        'Email settings: https://familygreenhouse.net/settings',
        '',
      ].join('\n')
    );
    expect(FOOTER_REASON).toBe(
      'You are getting this because you have a Family Greenhouse account and our emails to you were affected.'
    );
  });

  it('the HTML part carries every approved paragraph, the settings link and the footer', () => {
    const { html } = composeEmailOutageNotice({
      name: 'Sam',
      email: 'sam@example.com',
      trial: TRIAL,
      timeZone: 'America/Los_Angeles',
    });
    const escape = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const paragraphs = approvedBody('Hi Sam,', APPROVED_TRIAL_PARAGRAPH)
      .split('\n\n')
      .flatMap((p) => p.split('\n'))
      .map((p) =>
        p.startsWith('You can choose') ? 'You can choose which emails you get in Settings:' : p
      );
    for (const p of paragraphs) expect(html).toContain(escape(p));
    expect(html).toContain('href="https://familygreenhouse.net/settings?section=notifications"');
    expect(html).toContain(escape(FOOTER_REASON));
  });
});

describe('greetingName', () => {
  it('uses the first word of the stored name', () => {
    expect(greetingName('  Sam   Rivera ', 'sam@example.com')).toBe('Sam');
  });
  it('treats an empty name, an address, or the address local part as no name', () => {
    expect(greetingName('', 'sam@example.com')).toBeNull();
    expect(greetingName(null, 'sam@example.com')).toBeNull();
    expect(greetingName('sam@example.com', 'sam@example.com')).toBeNull();
    expect(greetingName('sam.r+fg', 'sam.r+fg@example.com')).toBeNull();
    expect(greetingName('Sam', 'sam@example.com')).toBe('Sam');
  });
});

// ---------------------------------------------------------------------------
// The trial paragraph rule
// ---------------------------------------------------------------------------

describe('endedTrialDuringOutage', () => {
  const at = (endsAt: string, extra: Partial<HouseholdSubscription> = {}) =>
    endedTrialDuringOutage({ planId: 'seedling', noCardTrialEndsAt: endsAt, ...extra }, NOW);

  it('returns the window for a no-card trial that ended in the outage, on Seedling', () => {
    expect(at(TRIAL.endedAt)).toEqual(TRIAL);
  });

  it('includes both edges: 2026-09-04 and the whole of 2026-11-19 (UTC)', () => {
    expect(at('2026-09-04T00:00:00.000Z')).not.toBeNull();
    expect(at('2026-11-19T23:59:59.000Z')).not.toBeNull();
  });

  it('excludes a trial that ended before or after the outage', () => {
    expect(at('2026-09-03T23:59:59.000Z')).toBeNull();
    expect(at('2026-11-20T00:00:00.000Z')).toBeNull();
  });

  it('excludes a trial still running, and a household that never had one', () => {
    expect(at('2026-12-01T00:00:00.000Z')).toBeNull();
    expect(endedTrialDuringOutage({ planId: 'seedling' }, NOW)).toBeNull();
  });

  it('excludes a household on a paid plan by any route', () => {
    expect(
      at(TRIAL.endedAt, { planId: 'garden', status: 'active', stripeSubscriptionId: 'sub_1' })
    ).toBeNull();
    expect(at(TRIAL.endedAt, { status: 'canceled', stripeSubscriptionId: 'sub_1' })).toBeNull();
    expect(at(TRIAL.endedAt, { lifetimePlanId: 'garden' })).toBeNull();
    expect(
      at(TRIAL.endedAt, { giftPlanId: 'garden', giftEndsAt: '2027-01-01T00:00:00.000Z' })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Planning and sending
// ---------------------------------------------------------------------------

describe('planEmailOutageNotice', () => {
  it('reads only: no marker write, no send, no suppression write', async () => {
    install({
      households: { h1: { creator: 'u1', sub: SEEDLING, members: [person('u1', 'admin')] } },
    });
    const plan = await planEmailOutageNotice({ now: NOW });
    await previewSuppression(plan.recipients);
    expect(plan.recipients).toHaveLength(1);
    expect(commands.every((c) => c.kind === 'Get')).toBe(true);
    expect(emailNotifier.sendEmailAccepted).not.toHaveBeenCalled();
  });

  it('skips a person whose prefs.email is off', async () => {
    install({
      households: {
        h1: {
          creator: 'u1',
          sub: SEEDLING,
          members: [person('u1', 'admin'), person('u2', 'member')],
        },
      },
      emailOff: ['u2'],
    });
    const plan = await planEmailOutageNotice({ now: NOW });
    expect(plan.recipients.map((r) => r.userId)).toEqual(['u1']);
    expect(plan.skipped.emailOff).toBe(1);
  });

  it('leaves out households whose creator is missing from Cognito', async () => {
    install({
      households: {
        real: { creator: 'u1', sub: SEEDLING, members: [person('u1', 'admin')] },
        test: { creator: 'gone', sub: SEEDLING, members: [person('t1', 'admin')] },
        nocreator: { creator: null, sub: SEEDLING, members: [person('t2', 'admin')] },
      },
      missingCreators: ['gone'],
    });
    const plan = await planEmailOutageNotice({ now: NOW });
    expect(plan.recipients.map((r) => r.userId)).toEqual(['u1']);
    expect(plan.householdsExcludedAsTest).toBe(2);
  });

  it('stops on a Cognito error other than "user not found"', async () => {
    vi.mocked(cognito.send).mockRejectedValueOnce(
      Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' })
    );
    await expect(cognitoUserExists('u1')).rejects.toThrow('throttled');
  });

  it('with an allowlist, considers only the listed households and skips Cognito', async () => {
    install({
      households: {
        h1: { creator: 'u1', sub: SEEDLING, members: [person('u1', 'admin')] },
        h2: { creator: 'u2', sub: SEEDLING, members: [person('u2', 'admin')] },
      },
    });
    const plan = await planEmailOutageNotice({ now: NOW, allowlist: new Set(['h2']) });
    expect(plan.recipients.map((r) => r.userId)).toEqual(['u2']);
    expect(plan.householdsNotAllowlisted).toBe(1);
    expect(cognito.send).not.toHaveBeenCalled();
  });

  it('gives the trial paragraph to admins of an ended-trial household only', async () => {
    install({
      households: {
        ended: {
          creator: 'a1',
          sub: ENDED_IN_OUTAGE,
          members: [person('a1', 'admin'), person('m1', 'member')],
        },
        plain: { creator: 'a2', sub: SEEDLING, members: [person('a2', 'admin')] },
        paid: {
          creator: 'a3',
          sub: {
            ...ENDED_IN_OUTAGE,
            planId: 'garden',
            status: 'active',
            stripeSubscriptionId: 'sub_1',
          },
          members: [person('a3', 'admin')],
        },
      },
    });
    const plan = await planEmailOutageNotice({ now: NOW });
    const trialOf = Object.fromEntries(plan.recipients.map((r) => [r.userId, r.trial]));
    expect(trialOf).toEqual({ a1: TRIAL, m1: null, a2: null, a3: null });
    expect(plan.householdsWithEndedTrial).toBe(1);
  });

  it('mails a person in two households once, with the trial paragraph if either earns it', async () => {
    install({
      households: {
        h1: { creator: 'u1', sub: SEEDLING, members: [person('u1', 'admin')] },
        h2: { creator: 'u1', sub: ENDED_IN_OUTAGE, members: [person('u1', 'admin')] },
      },
    });
    const plan = await planEmailOutageNotice({ now: NOW });
    expect(plan.recipients).toHaveLength(1);
    expect(plan.recipients[0]?.trial).toEqual(TRIAL);
  });

  it('skips a member with no address', async () => {
    install({
      households: {
        h1: { creator: 'u1', sub: SEEDLING, members: [person('u1', 'admin', { email: '' })] },
      },
    });
    const plan = await planEmailOutageNotice({ now: NOW });
    expect(plan.recipients).toHaveLength(0);
    expect(plan.skipped.noAddress).toBe(1);
  });
});

describe('sendEmailOutageNotice', () => {
  const recipient = (userId: string, trial = false): PlannedRecipient => ({
    userId,
    email: `${userId}@example.com`,
    name: 'Sam',
    timeZone: 'UTC',
    trial: trial ? TRIAL : null,
  });

  it('sends through sendEmailAccepted with the composed message', async () => {
    const summary = await sendEmailOutageNotice([recipient('u1', true)], { now: NOW });
    expect(summary).toMatchObject({ sent: 1, sentWithTrialParagraph: 1 });
    const msg = vi.mocked(emailNotifier.sendEmailAccepted).mock.calls[0]?.[0];
    expect(msg?.to).toBe('u1@example.com');
    expect(msg?.subject).toBe(APPROVED_SUBJECT);
    expect(msg?.html).toContain('<!DOCTYPE html>');
    expect(msg?.text).toContain("Your household's free Garden trial ran from");
  });

  it('the marker stops a second run from mailing anyone twice', async () => {
    await sendEmailOutageNotice([recipient('u1')], { now: NOW });
    const second = await sendEmailOutageNotice([recipient('u1')], { now: NOW });
    expect(second).toMatchObject({ sent: 0, alreadySent: 1 });
    expect(emailNotifier.sendEmailAccepted).toHaveBeenCalledTimes(1);

    // And a fresh plan counts them as already sent, without sending.
    install({
      households: { h1: { creator: 'u1', sub: SEEDLING, members: [person('u1', 'admin')] } },
    });
    const plan = await planEmailOutageNotice({ now: NOW });
    expect(plan.recipients).toHaveLength(0);
    expect(plan.skipped.alreadySent).toBe(1);
  });

  it('a suppressed address is not mailed, and its marker is released', async () => {
    vi.mocked(emailNotifier.sendEmailAccepted).mockResolvedValueOnce({
      accepted: false,
      reason: 'suppressed',
    });
    const summary = await sendEmailOutageNotice([recipient('u1')], { now: NOW });
    expect(summary).toMatchObject({ sent: 0, suppressed: 1 });
    expect(markers.size).toBe(0);
  });

  it('the dry-run suppression preview counts a suppressed address and drops it', async () => {
    vi.mocked(emailSuppression.checkAddress)
      .mockResolvedValueOnce({
        status: 'suppressed',
        state: { state: 'suppressed', reason: 'hard_bounce' },
      } as Awaited<ReturnType<typeof emailSuppression.checkAddress>>)
      .mockResolvedValueOnce({ status: 'unknown', reason: 'lookup_failed' } as Awaited<
        ReturnType<typeof emailSuppression.checkAddress>
      >);
    const preview = await previewSuppression([recipient('u1'), recipient('u2'), recipient('u3')]);
    expect(preview).toMatchObject({ suppressed: 1, suppressionUnknown: 1 });
    expect(preview.sendable.map((r) => r.userId)).toEqual(['u3']);
  });

  it('a failed or unconfigured send releases the marker so a re-run retries', async () => {
    vi.mocked(emailNotifier.sendEmailAccepted)
      .mockRejectedValueOnce(new Error('SES down'))
      .mockResolvedValueOnce({ accepted: false, reason: 'dry_run' });
    const summary = await sendEmailOutageNotice([recipient('u1'), recipient('u2')], { now: NOW });
    expect(summary).toMatchObject({ sent: 0, failed: 1, notConfigured: 1 });
    expect(markers.size).toBe(0);
  });
});
