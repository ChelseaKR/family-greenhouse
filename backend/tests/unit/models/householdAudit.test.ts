/**
 * The pure half of the household audit log (#675): what an entry may carry,
 * how a member is referenced, what the admin page is shown, and what a Stripe
 * event means for the log.
 *
 * Every negative control here asserts its sabotage LANDED before asserting it
 * was refused: the secret is shown to be present in what the producer passed,
 * then absent from what would be stored. A refusal that never saw the secret
 * would pass either way.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_DETAIL_KEYS,
  AUDIT_RETENTION_DAYS,
  HOUSEHOLD_AUDIT_KINDS,
  auditMemberRef,
  billingAuditEntries,
  buildAuditItem,
  isAuditItemExpired,
  isSafeDetailValue,
  sanitizeAuditDetails,
  toAuditEntryView,
  type RecordHouseholdAuditInput,
} from '../../../src/models/householdAudit.js';
import { hashCapabilityToken } from '../../../src/utils/tokenHash.js';

const HH = '0b5e8a52-5f1e-4c0c-9a51-1c9d7f7d2a01';
const ADA = 'a1f6c0a2-0000-4000-8000-000000000001';
const MEL = 'a1f6c0a2-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-18T12:00:00.000Z');

/** Every credential shape the codebase mints, freshly generated. */
function secrets(): Record<string, string> {
  const token64 = randomBytes(32).toString('hex'); // sitter / kiosk / tag / caretaker
  const code32 = randomBytes(16).toString('hex'); // invite / cutting share
  return {
    token64,
    code32,
    apiKey: `fg_${randomBytes(24).toString('hex')}`,
    digest: hashCapabilityToken('sitterLink', token64),
    base64url: randomBytes(24).toString('base64url'),
    email: 'someone.else@example.invalid',
    card: '4242 4242 4242 4242',
    note: 'keep away from the cat, she ate the last one',
  };
}

describe('isSafeDetailValue', () => {
  it('refuses every credential shape, an address, a card number and free text', () => {
    for (const [shape, value] of Object.entries(secrets())) {
      expect(isSafeDetailValue(value), shape).toBe(false);
    }
  });

  it('accepts what entries legitimately carry: ids, instants, enums, scopes, a last four, counts', () => {
    for (const value of [
      ADA,
      '2026-09-18T12:00:00.000Z',
      'greenhouse',
      'past_due',
      'read:plants,read:tasks,read:activity,write:tasks',
      '9f3a',
      'email',
      3,
      0,
      true,
      null,
    ]) {
      expect(isSafeDetailValue(value), String(value)).toBe(true);
    }
  });

  it('refuses non-scalars and non-finite numbers', () => {
    expect(isSafeDetailValue({ a: 1 })).toBe(false);
    expect(isSafeDetailValue(['x'])).toBe(false);
    expect(isSafeDetailValue(Number.NaN)).toBe(false);
    expect(isSafeDetailValue(undefined)).toBe(false);
  });
});

describe('sanitizeAuditDetails', () => {
  it('drops a key the kind does not allow, reporting its NAME and never its value', () => {
    const { token64 } = secrets();
    const passed = { linkId: ADA, token: token64 };
    // The sabotage landed: the producer really did pass the token.
    expect(JSON.stringify(passed)).toContain(token64);

    const { details, dropped } = sanitizeAuditDetails('sitter_link.revoked', passed);
    expect(details).toEqual({ linkId: ADA });
    expect(dropped).toEqual(['token']);
    expect(JSON.stringify({ details, dropped })).not.toContain(token64);
  });

  it('drops an ALLOWED key whose value is credential-shaped — a token passed as the link id', () => {
    const { token64 } = secrets();
    const { details, dropped } = sanitizeAuditDetails('sitter_link.revoked', {
      linkId: token64,
    });
    expect(details).toEqual({});
    expect(dropped).toEqual(['linkId']);
  });

  it('skips undefined optionals without counting them as drops', () => {
    expect(
      sanitizeAuditDetails('billing.plan_changed', {
        plan: 'garden',
        status: undefined,
        via: 'checkout',
      })
    ).toEqual({ details: { plan: 'garden', via: 'checkout' }, dropped: [] });
  });

  it('has an allowlist entry for every kind', () => {
    expect(Object.keys(AUDIT_DETAIL_KEYS).sort()).toEqual([...HOUSEHOLD_AUDIT_KINDS].sort());
  });
});

describe('auditMemberRef', () => {
  it('is stable for a member of a household and different in another household', () => {
    expect(auditMemberRef(HH, ADA)).toBe(auditMemberRef(HH, ADA));
    expect(auditMemberRef(HH, ADA)).not.toBe(auditMemberRef(HH, MEL));
    expect(auditMemberRef(HH, ADA)).not.toBe(auditMemberRef('other-household', ADA));
  });

  it('does not contain the user id', () => {
    const ref = auditMemberRef(HH, ADA);
    expect(ref).toHaveLength(22);
    expect(ref).not.toContain(ADA);
    expect(ref).not.toContain(ADA.slice(0, 8));
  });
});

describe('buildAuditItem', () => {
  const input: RecordHouseholdAuditInput = {
    householdId: HH,
    kind: 'member.role_changed',
    actor: { type: 'member', userId: ADA },
    targetUserId: MEL,
    details: { from: 'member', to: 'admin' },
  };

  it('writes an append-only row in the household audit partition with a retention ttl', () => {
    const { item } = buildAuditItem(input, { id: 'e1', now: NOW, gapBefore: false });
    expect(item).toEqual({
      PK: `HOUSEHOLD#${HH}#AUDIT`,
      SK: 'AUDIT#2026-09-18T12:00:00.000Z#e1',
      entityType: 'HouseholdAuditEntry',
      id: 'e1',
      householdId: HH,
      kind: 'member.role_changed',
      occurredAt: '2026-09-18T12:00:00.000Z',
      actorType: 'member',
      actorRef: auditMemberRef(HH, ADA),
      targetRef: auditMemberRef(HH, MEL),
      details: { from: 'member', to: 'admin' },
      ttl: Math.floor(NOW.getTime() / 1000) + AUDIT_RETENTION_DAYS * 86_400,
    });
  });

  it('stores refs, never the user ids themselves', () => {
    const { item } = buildAuditItem(input, { id: 'e1', now: NOW, gapBefore: false });
    const stored = JSON.stringify(item);
    expect(JSON.stringify(input)).toContain(ADA);
    expect(stored).not.toContain(ADA);
    expect(stored).not.toContain(MEL);
  });

  it('carries gapBefore only when asked, and never an actor ref for Stripe', () => {
    const { item } = buildAuditItem(
      {
        householdId: HH,
        kind: 'billing.payment_failed',
        actor: { type: 'stripe' },
        details: { plan: 'garden', status: 'past_due' },
      },
      { id: 'e2', now: NOW, gapBefore: true }
    );
    expect(item.gapBefore).toBe(true);
    expect(item.actorType).toBe('stripe');
    expect(item).not.toHaveProperty('actorRef');
    expect(item).not.toHaveProperty('targetRef');
  });

  it('is 30 days of retention, the DPIA figure', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(30);
  });
});

describe('toAuditEntryView', () => {
  const roster = [
    { userId: ADA, name: 'Ada Admin' },
    { userId: MEL, name: 'Mel Member' },
  ];
  const row = (over: Record<string, unknown>) => ({
    id: 'e1',
    kind: 'member.removed',
    occurredAt: '2026-09-18T12:00:00.000Z',
    actorType: 'member',
    actorRef: auditMemberRef(HH, ADA),
    details: { role: 'member' },
    ...over,
  });

  it('names a current member by display name', () => {
    expect(toAuditEntryView(row({}), HH, roster).actor).toEqual({
      type: 'member',
      name: 'Ada Admin',
    });
  });

  it('shows someone no longer on the roster as a former member', () => {
    const gone = 'a1f6c0a2-0000-4000-8000-00000000dead';
    const view = toAuditEntryView(row({ targetRef: auditMemberRef(HH, gone) }), HH, roster);
    expect(view.target).toEqual({ type: 'former_member' });
  });

  it('does not resolve a member of ANOTHER household by their ref', () => {
    // Same user id, different household: the ref must not match.
    const view = toAuditEntryView(
      row({ actorRef: auditMemberRef('another-household', ADA) }),
      HH,
      roster
    );
    expect(view.actor).toEqual({ type: 'former_member' });
  });

  it('shows Stripe as Stripe, passes unknown kinds through, and reports gaps', () => {
    const view = toAuditEntryView(
      row({
        actorType: 'stripe',
        actorRef: undefined,
        kind: 'billing.something_new',
        gapBefore: true,
      }),
      HH,
      roster
    );
    expect(view.actor).toEqual({ type: 'stripe' });
    expect(view.kind).toBe('billing.something_new');
    expect(view.gapBefore).toBe(true);
    expect(view.target).toBeNull();
  });

  it('re-checks stored details on the way out: an unsafe value in a row is not served', () => {
    const { token64 } = secrets();
    const view = toAuditEntryView(
      row({ details: { role: 'member', leaked: token64 } }),
      HH,
      roster
    );
    expect(view.details).toEqual({ role: 'member' });
  });
});

describe('isAuditItemExpired', () => {
  it('is expired at or after its ttl, which DynamoDB may not have swept yet', () => {
    const ttl = Math.floor(NOW.getTime() / 1000);
    expect(isAuditItemExpired({ ttl }, NOW)).toBe(true);
    expect(isAuditItemExpired({ ttl: ttl + 1 }, NOW)).toBe(false);
    expect(isAuditItemExpired({}, NOW)).toBe(false);
  });
});

describe('billingAuditEntries', () => {
  it('a completed checkout is a plan change (a trial start reads as status trialing)', () => {
    expect(
      billingAuditEntries('checkout.session.completed', null, {
        planId: 'garden',
        status: 'trialing',
      })
    ).toEqual([
      {
        kind: 'billing.plan_changed',
        details: { plan: 'garden', status: 'trialing', via: 'checkout' },
      },
    ]);
  });

  it('active → past_due is a failed payment; past_due → unpaid is not a second one', () => {
    expect(
      billingAuditEntries(
        'customer.subscription.updated',
        { status: 'active' },
        {
          planId: 'greenhouse',
          status: 'past_due',
        }
      )
    ).toEqual([
      { kind: 'billing.payment_failed', details: { plan: 'greenhouse', status: 'past_due' } },
    ]);
    expect(
      billingAuditEntries(
        'customer.subscription.updated',
        { status: 'past_due' },
        {
          planId: 'greenhouse',
          status: 'unpaid',
        }
      )
    ).toEqual([]);
  });

  it('past_due / unpaid / incomplete → active is a recovered payment; trialing → active is not', () => {
    for (const from of ['past_due', 'unpaid', 'incomplete']) {
      expect(
        billingAuditEntries(
          'customer.subscription.updated',
          { status: from },
          {
            planId: 'garden',
            status: 'active',
          }
        ),
        from
      ).toEqual([
        { kind: 'billing.payment_recovered', details: { plan: 'garden', status: 'active' } },
      ]);
    }
    expect(
      billingAuditEntries(
        'customer.subscription.updated',
        { status: 'trialing' },
        {
          planId: 'garden',
          status: 'active',
        }
      )
    ).toEqual([]);
  });

  it('a price move is a plan change; a renewal or metadata edit is nothing', () => {
    expect(
      billingAuditEntries(
        'customer.subscription.updated',
        { items: { data: [] } },
        { planId: 'greenhouse', status: 'active' }
      )
    ).toEqual([
      {
        kind: 'billing.plan_changed',
        details: { plan: 'greenhouse', status: 'active', via: 'subscription' },
      },
    ]);
    expect(
      billingAuditEntries(
        'customer.subscription.updated',
        { current_period_end: 1 },
        { planId: 'greenhouse', status: 'active' }
      )
    ).toEqual([]);
  });

  it('a deleted subscription is a plan change to what the household keeps; created is silent', () => {
    expect(
      billingAuditEntries('customer.subscription.deleted', null, {
        planId: 'seedling',
        status: 'canceled',
      })
    ).toEqual([
      {
        kind: 'billing.plan_changed',
        details: { plan: 'seedling', status: 'canceled', via: 'ended' },
      },
    ]);
    expect(
      billingAuditEntries('customer.subscription.created', null, {
        planId: 'garden',
        status: 'trialing',
      })
    ).toEqual([]);
    expect(billingAuditEntries('invoice.payment_failed', null, { planId: 'garden' })).toEqual([]);
  });

  it('cannot see anything on the event but its type and previous status/items', () => {
    // Negative control: a previous_attributes carrying Stripe's customer
    // email and a card's last four. The classifier's output must hold none
    // of it — it only ever reads `status`, `items` and `plan`.
    const previous = {
      status: 'active',
      customer_email: 'payer@example.invalid',
      default_payment_method: { card: { last4: '4242', brand: 'visa' } },
    };
    expect(JSON.stringify(previous)).toContain('payer@example.invalid');
    const out = JSON.stringify(
      billingAuditEntries('customer.subscription.updated', previous, {
        planId: 'garden',
        status: 'past_due',
      })
    );
    expect(out).toContain('payment_failed');
    expect(out).not.toContain('payer@example.invalid');
    expect(out).not.toContain('4242');
    expect(out).not.toContain('visa');
  });
});
