import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// billing.ts (imported for REAL below, unmocked) is the module under test's
// only source of truth for staleness — see the module header on why. Mocking
// it here would defeat the point: these tests exist to prove this job
// actually respects `staleCheckoutMarker`'s real threshold, not a stand-in.
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../src/services/householdService.js', () => ({
  listAllHouseholdIds: vi.fn(),
  getHouseholdMembers: vi.fn(),
}));
vi.mock('../../../src/services/email/locale.js', () => ({
  resolveEmailLocaleForUser: vi.fn(),
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as emailNotifier from '../../../src/services/emailNotifier.js';
import * as householdService from '../../../src/services/householdService.js';
import * as emailLocale from '../../../src/services/email/locale.js';
import { runCheckoutRecoveryEmails } from '../../../src/services/checkoutRecoveryEmails.js';
import { PENDING_CHECKOUT_WINDOW_MS } from '../../../src/services/billing.js';

interface FakeCommand {
  kind: 'Put' | 'Get' | 'Delete' | 'Update';
  input: {
    Key?: { PK?: string; SK?: string };
    Item?: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
}

let rows: Map<string, Record<string, unknown>>;

function keyOf(cmd: FakeCommand): string {
  const key = cmd.input.Key ?? {
    PK: cmd.input.Item?.PK as string,
    SK: cmd.input.Item?.SK as string,
  };
  return `${key.PK}|${key.SK}`;
}

function conditionalFailure(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

/**
 * A faithful-enough evaluator for the THREE condition shapes this module and
 * `scheduledFanOut.ts`'s checkpoint actually send, so a claim/finalize/release
 * sequence behaves the way real DynamoDB would across TWO independent runs of
 * `runCheckoutRecoveryEmails` — no test manually flips a "claimed" flag
 * in between. That is the whole point of the idempotency tests below.
 */
function conditionHolds(
  cond: string | undefined,
  values: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
): boolean {
  if (!cond) return true; // writeCheckpoint, forceCloseSlot: unconditional.
  if (cond.startsWith('attribute_not_exists(PK)')) {
    // claimSlot
    if (!existing) return true;
    return (
      existing.status === values[':sending'] &&
      (existing.leaseExpiresAt as number) <= (values[':now'] as number)
    );
  }
  if (cond.includes('#status = :sending AND reservationId')) {
    // finalizeSlot
    return (
      !!existing &&
      existing.status === values[':sending'] &&
      existing.reservationId === values[':reservationId']
    );
  }
  if (cond === 'reservationId = :reservationId') {
    // releaseSlot
    return !!existing && existing.reservationId === values[':reservationId'];
  }
  return true;
}

function installFakeTable(): void {
  vi.mocked(dynamodb.send).mockImplementation((command: unknown) => {
    const cmd = command as FakeCommand;
    const key = keyOf(cmd);
    const existing = rows.get(key);
    if (cmd.kind === 'Get') return Promise.resolve({ Item: existing }) as never;
    const ok = conditionHolds(
      cmd.input.ConditionExpression,
      cmd.input.ExpressionAttributeValues ?? {},
      existing
    );
    if (!ok) return Promise.reject(conditionalFailure()) as never;
    if (cmd.kind === 'Put') {
      rows.set(key, cmd.input.Item ?? {});
      return Promise.resolve({}) as never;
    }
    if (cmd.kind === 'Update') {
      // Mirrors finalizeSlot's own UpdateExpression: mark sent, drop the lease.
      rows.set(key, {
        ...existing,
        status: 'sent',
        sentAt: new Date().toISOString(),
        leaseExpiresAt: undefined,
        reservationId: undefined,
      });
      return Promise.resolve({}) as never;
    }
    if (cmd.kind === 'Delete') {
      rows.delete(key);
      return Promise.resolve({}) as never;
    }
    return Promise.resolve({}) as never;
  });
}

function householdKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}|METADATA`;
}

/**
 * Seeds a household row whose pending-checkout marker is `ageMs` old, as of
 * the REAL wall clock — `billing.getHouseholdSubscription` calls
 * `staleCheckoutMarker` with no injected clock (it always reads `Date.now()`;
 * see `services/billing.ts`), so a fixed test date cannot drive it, and these
 * tests deliberately do not pin the exact `PENDING_CHECKOUT_WINDOW_MS`
 * boundary the way `billing.test.ts` does for the pure function directly —
 * that would race the real clock between this call and the internal
 * `Date.now()` read. `FRESH_MARGIN_MS`/`STALE_MARGIN_MS` below stay minutes
 * clear of the boundary on both sides instead.
 */
function seedMarker(householdId: string, ageMs: number, sessionId = 'cs_1'): string {
  const startedAt = new Date(Date.now() - ageMs).toISOString();
  rows.set(householdKey(householdId), {
    planId: 'seedling',
    pendingCheckoutSessionId: sessionId,
    pendingCheckoutAt: startedAt,
  });
  return startedAt;
}

/** Comfortably inside the window — `pendingCheckoutState` reads `fresh`. */
const FRESH_AGE_MS = 5 * 60 * 1000;
/** Comfortably past the window — `pendingCheckoutState` reads `stale`. The
 *  exact boundary itself is `billing.test.ts`'s job (PR #790), not this
 *  file's — see the comment on `seedMarker`. */
const STALE_AGE_MS = PENDING_CHECKOUT_WINDOW_MS + 5 * 60 * 1000;

const ADMIN = {
  householdId: 'hh-1',
  userId: 'user-admin',
  name: 'Sam',
  email: 'admin@example.com',
  role: 'admin' as const,
  joinedAt: '2026-01-01T00:00:00.000Z',
};
const SECOND_ADMIN = { ...ADMIN, userId: 'user-admin-2', email: 'admin2@example.com' };
const MEMBER = {
  ...ADMIN,
  userId: 'user-member',
  email: 'member@example.com',
  role: 'member' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
  process.env.FRONTEND_URL = 'https://familygreenhouse.net';
  installFakeTable();

  vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh-1']);
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([ADMIN]);
  vi.mocked(emailLocale.resolveEmailLocaleForUser).mockResolvedValue({
    locale: 'en',
    source: 'default',
  });
  vi.mocked(emailNotifier.sendEmail).mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.FRONTEND_URL;
});

describe('runCheckoutRecoveryEmails — the staleness threshold is enforced, not assumed', () => {
  it('sends nothing for a fresh marker (negative control) and sends once it reads stale', async () => {
    seedMarker('hh-1', FRESH_AGE_MS);
    const fresh = await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
    expect(fresh.stale).toBe(0);
    expect(fresh.sent).toBe(0);

    // Same session, now exactly at the threshold #790's own test pins.
    seedMarker('hh-1', STALE_AGE_MS);
    const stale = await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
    expect(stale.stale).toBe(1);
    expect(stale.sent).toBe(1);
  });

  it('sends nothing when there is no marker at all', async () => {
    rows.set(householdKey('hh-1'), { planId: 'seedling' });
    const summary = await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
    expect(summary.stale).toBe(0);
  });

  it('sends nothing once the checkout has settled — even for an attempt old enough to be stale', async () => {
    // Models `applyStripeEvent`'s `settlesPendingCheckout` branch, which
    // clears `pendingCheckoutSessionId`/`pendingCheckoutAt` in the SAME write
    // that records the subscription — including for a delayed
    // `checkout.session.async_payment_succeeded`. By the time this job reads
    // the row, there is no marker left to be stale.
    rows.set(householdKey('hh-1'), {
      planId: 'garden',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    });
    const summary = await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
    expect(summary.stale).toBe(0);
  });
});

describe('runCheckoutRecoveryEmails — exactly once per checkout attempt', () => {
  it('never double-sends when the job runs twice against the same attempt', async () => {
    seedMarker('hh-1', STALE_AGE_MS);
    const first = await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
    expect(first.sent).toBe(1);

    vi.mocked(emailNotifier.sendEmail).mockClear();
    const second = await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
    expect(second.alreadySent).toBe(1);
    expect(second.sent).toBe(0);
  });

  it('emails a NEW checkout attempt even though a previous attempt already got its recovery email', async () => {
    seedMarker('hh-1', STALE_AGE_MS, 'cs_1');
    await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);

    // Household abandoned checkout again — a fresh Session and a fresh
    // pendingCheckoutAt superseded the old marker entirely. A different age
    // (not just a different session id) so `startedAt` genuinely differs —
    // that ISO timestamp is this module's only identifier of "which attempt".
    seedMarker('hh-1', STALE_AGE_MS + 60_000, 'cs_2');
    vi.mocked(emailNotifier.sendEmail).mockClear();
    const summary = await runCheckoutRecoveryEmails(new Date());
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(1);
  });

  it('releases the slot when the send does not land, so a later run can retry', async () => {
    seedMarker('hh-1', STALE_AGE_MS);
    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(false); // dry run (SES unconfigured)
    const first = await runCheckoutRecoveryEmails(new Date());
    expect(first.failed).toBe(1);
    expect(first.sent).toBe(0);

    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(true);
    const second = await runCheckoutRecoveryEmails(new Date());
    expect(second.sent).toBe(1);
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('keys the marker per recipient, so one blocked admin does not mute the other', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([ADMIN, SECOND_ADMIN]);
    seedMarker('hh-1', STALE_AGE_MS);
    await runCheckoutRecoveryEmails(new Date());
    const firstRecipients = vi.mocked(emailNotifier.sendEmail).mock.calls.map((c) => c[0].to);
    expect(firstRecipients.sort()).toEqual(['admin2@example.com', 'admin@example.com']);
  });
});

describe('runCheckoutRecoveryEmails — who gets it', () => {
  it('emails admins only, never an ordinary member', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([ADMIN, MEMBER]);
    seedMarker('hh-1', STALE_AGE_MS);
    await runCheckoutRecoveryEmails(new Date());
    const recipients = vi.mocked(emailNotifier.sendEmail).mock.calls.map((c) => c[0].to);
    expect(recipients).toEqual(['admin@example.com']);
  });

  it('counts noRecipient and sends nothing when no admin carries an address', async () => {
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([MEMBER]);
    seedMarker('hh-1', STALE_AGE_MS);
    const summary = await runCheckoutRecoveryEmails(new Date());
    expect(summary.noRecipient).toBe(1);
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('threads the resolved per-recipient locale into the composed email', async () => {
    vi.mocked(emailLocale.resolveEmailLocaleForUser).mockResolvedValue({
      locale: 'es',
      source: 'user',
    });
    seedMarker('hh-1', STALE_AGE_MS);
    await runCheckoutRecoveryEmails(new Date());
    const sent = vi.mocked(emailNotifier.sendEmail).mock.calls[0][0];
    expect(sent.text).toContain('Gracias por cultivar con nosotros');
    expect(emailLocale.resolveEmailLocaleForUser).toHaveBeenCalledWith('user-admin', 'hh-1');
  });
});

describe('runCheckoutRecoveryEmails — never breaks the scheduled run', () => {
  it('counts a per-household failure and keeps processing the rest', async () => {
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh-bad', 'hh-1']);
    seedMarker('hh-bad', STALE_AGE_MS);
    seedMarker('hh-1', STALE_AGE_MS);
    vi.mocked(householdService.getHouseholdMembers).mockImplementation((householdId: string) =>
      householdId === 'hh-bad' ? Promise.reject(new Error('ddb down')) : Promise.resolve([ADMIN])
    );

    const result = await runCheckoutRecoveryEmails(new Date());
    expect(result.errors).toBe(1);
    expect(result.sent).toBe(1);
    expect(emailNotifier.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailNotifier.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@example.com' })
    );
  });
});
