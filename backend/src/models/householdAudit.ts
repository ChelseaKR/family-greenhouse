/**
 * Household audit log (#675) — the pure half.
 *
 * An append-only, admin-visible record of what was done TO the household:
 * membership, credentials that open a door into it, and billing. It is not the
 * activity feed (which is plant-shaped and every member reads) and it is not
 * the ops audit trail in `utils/auditLog.ts` (CloudWatch lines that carry the
 * actor's email and IP for 30 days, read by operators, never by households).
 *
 * This file holds everything that does no I/O — the vocabulary, what each
 * entry may carry, the member reference, the stored-row builder and the view
 * the admin page reads — so the dev server can import it. The DynamoDB half is
 * `services/householdAudit.ts`.
 *
 * What an entry can never carry, by construction rather than by care:
 *
 *   - A credential. No producer passes a token, and every detail value goes
 *     through `isSafeDetailValue`, which refuses anything credential-shaped —
 *     a long run of hex or base64url (tokens, invite and share codes, API
 *     keys, their scrypt digests), anything with an `@` or a space, anything
 *     over 64 characters. A refused value is dropped and the entry still
 *     lands; the drop is logged with the key name, never the value.
 *   - A member's identity. Actors and targets are stored as `auditMemberRef`,
 *     a per-household SHA-256 of the user id. The reader resolves it against
 *     the CURRENT roster; anyone no longer on it reads as "former member".
 *     After an account deletion nothing anywhere links the ref back to a
 *     person, so the entry needs no rewrite — which is what lets the log stay
 *     append-only and still honour the privacy page's promise that a deleted
 *     account's id is replaced on shared records.
 *   - Free text. No label, plant name, caretaker name, note or address: every
 *     detail is an enum, a count, an id, an instant or an API key's last four.
 *   - Anything about a non-member: an emailed invite records the channel, not
 *     the address.
 */
import { createHash } from 'node:crypto';

/**
 * How long an audit entry is kept, in days. THE one-line retention config.
 *
 * 30 days because that is the retention the DPIA already states for the
 * security audit log (`docs/audits/dpia.md`, "Legitimate interest — 30-day
 * security audit log"), and the one the CloudWatch audit trail has always had
 * (`docs/compliance.md`). #675 proposed two years "stated in the DPIA"; the
 * DPIA says no such thing, and a longer period is a new promise to make in the
 * DPIA and the privacy page first, not a number to change here alone.
 */
export const AUDIT_RETENTION_DAYS = 30;

/** Every kind of entry the log records. */
export const HOUSEHOLD_AUDIT_KINDS = [
  'household.created',
  'member.joined',
  'member.left',
  'member.removed',
  'member.role_changed',
  'invite.created',
  'sitter_link.created',
  'sitter_link.revoked',
  'kiosk_link.created',
  'kiosk_link.revoked',
  'caretaker_seat.created',
  'caretaker_seat.revoked',
  'plant_tag.created',
  'plant_tag.revoked',
  'share_link.created',
  'api_key.created',
  'api_key.revoked',
  'billing.plan_changed',
  'billing.payment_failed',
  'billing.payment_recovered',
  'trash.restored',
  'trash.purged',
] as const;

export type HouseholdAuditKind = (typeof HOUSEHOLD_AUDIT_KINDS)[number];

type Role = 'admin' | 'member';

/** Credentials a departure revoked (#449), as counts — never which ones. */
interface RevokedCounts {
  sitterLinks?: number;
  plantTags?: number;
  kioskLinks?: number;
  cuttingShares?: number;
}

/**
 * What each kind may carry. Scalars only; ids are the NON-secret row ids
 * (uuids) the management screens already show, never a token.
 */
export interface HouseholdAuditDetailsByKind {
  'household.created': Record<string, never>;
  'member.joined': { role: Role };
  /** `accountDeleted`: they left by deleting their account (`DELETE /me`). */
  'member.left': RevokedCounts & { role: Role; releasedTasks?: number; accountDeleted?: boolean };
  'member.removed': RevokedCounts & { role: Role };
  'member.role_changed': { from: Role; to: Role };
  /** `link` = a copyable link, `email` = sent to an address we do not keep. */
  'invite.created': { channel: 'link' | 'email'; expiresAt: string };
  'sitter_link.created': { linkId: string; startsAt: string; expiresAt: string };
  'sitter_link.revoked': { linkId: string };
  'kiosk_link.created': { linkId: string };
  'kiosk_link.revoked': { count: number };
  'caretaker_seat.created': { seatId: string; expiresAt: string };
  'caretaker_seat.revoked': { seatId: string };
  'plant_tag.created': { tagId: string; plantId: string };
  'plant_tag.revoked': { plantId: string; count: number };
  'share_link.created': { plantId: string; expiresAt: string };
  /** `scopes` is the comma-joined list the key was granted. */
  'api_key.created': { keyId: string; last4: string; scopes: string };
  'api_key.revoked': { keyId: string };
  /**
   * `via` says what moved the plan: `checkout` (a purchase or a trial start —
   * `status` tells which), `subscription` (a change Stripe reported, e.g. in
   * the billing portal), `ended` (the subscription is gone; `plan` is what the
   * household keeps) or `gift` (a gift code placed on the household).
   */
  'billing.plan_changed': {
    plan: string;
    status?: string;
    via: 'checkout' | 'subscription' | 'ended' | 'gift';
    endsAt?: string;
  };
  'billing.payment_failed': { plan: string; status: string };
  'billing.payment_recovered': { plan: string; status: string };
  'trash.restored': { itemKind: 'plant' | 'task'; itemId: string };
  'trash.purged': { itemKind: 'plant' | 'task'; itemId: string };
}

type DetailKeys = {
  [K in HouseholdAuditKind]: ReadonlyArray<keyof HouseholdAuditDetailsByKind[K]>;
};

/**
 * The runtime allowlist behind the type above. A key a producer passes that is
 * not listed here is dropped before the row is written, so a future
 * `...link` spread cannot carry a token in under a new name.
 */
export const AUDIT_DETAIL_KEYS: DetailKeys = {
  'household.created': [],
  'member.joined': ['role'],
  'member.left': [
    'role',
    'releasedTasks',
    'accountDeleted',
    'sitterLinks',
    'plantTags',
    'kioskLinks',
    'cuttingShares',
  ],
  'member.removed': ['role', 'sitterLinks', 'plantTags', 'kioskLinks', 'cuttingShares'],
  'member.role_changed': ['from', 'to'],
  'invite.created': ['channel', 'expiresAt'],
  'sitter_link.created': ['linkId', 'startsAt', 'expiresAt'],
  'sitter_link.revoked': ['linkId'],
  'kiosk_link.created': ['linkId'],
  'kiosk_link.revoked': ['count'],
  'caretaker_seat.created': ['seatId', 'expiresAt'],
  'caretaker_seat.revoked': ['seatId'],
  'plant_tag.created': ['tagId', 'plantId'],
  'plant_tag.revoked': ['plantId', 'count'],
  'share_link.created': ['plantId', 'expiresAt'],
  'api_key.created': ['keyId', 'last4', 'scopes'],
  'api_key.revoked': ['keyId'],
  'billing.plan_changed': ['plan', 'status', 'via', 'endsAt'],
  'billing.payment_failed': ['plan', 'status'],
  'billing.payment_recovered': ['plan', 'status'],
  'trash.restored': ['itemKind', 'itemId'],
  'trash.purged': ['itemKind', 'itemId'],
};

/** Who did it. A member, or Stripe for what only the webhook knows. */
export type HouseholdAuditActor = { type: 'member'; userId: string } | { type: 'stripe' };

export type RecordHouseholdAuditInput = {
  [K in HouseholdAuditKind]: {
    householdId: string;
    kind: K;
    actor: HouseholdAuditActor;
    /** The member the action was done TO (role change, removal). */
    targetUserId?: string;
    details: HouseholdAuditDetailsByKind[K];
  };
}[HouseholdAuditKind];

export type AuditDetailValue = string | number | boolean | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Enums, plan ids, statuses, comma-joined scopes, last-4s. No `@`, no space,
// no slash: an address or a URL cannot pass.
const PLAIN = /^[A-Za-z0-9_:,.-]{1,64}$/;
// Credential-shaped runs. Tokens are 64 hex, invite/share codes 32 hex, API
// keys `fg_` + 48 hex, digests hex or base64url — every one trips at least
// one of these, while a uuid (checked first) and the enums above trip none.
const HEX_RUN = /[0-9a-f]{16,}/i;
const OPAQUE_RUN = /[A-Za-z0-9_-]{24,}/;

/**
 * Whether a detail value may be stored. The allowlist of keys decides WHICH
 * fields an entry has; this decides that no field smuggles a secret, whatever
 * a producer passes into it.
 */
export function isSafeDetailValue(value: unknown): value is AuditDetailValue {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (UUID.test(value) || ISO_INSTANT.test(value)) return true;
  if (!PLAIN.test(value)) return false;
  return !HEX_RUN.test(value) && !OPAQUE_RUN.test(value);
}

/**
 * Keep the allowlisted keys whose values are safe. Returns the kept details
 * and the NAMES of anything dropped, so the caller can log that a producer
 * tried — without logging what it tried.
 */
export function sanitizeAuditDetails(
  kind: HouseholdAuditKind,
  details: Record<string, unknown>
): { details: Record<string, AuditDetailValue>; dropped: string[] } {
  const allowed = new Set<string>(AUDIT_DETAIL_KEYS[kind] as readonly string[]);
  const kept: Record<string, AuditDetailValue> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (allowed.has(key) && isSafeDetailValue(value)) kept[key] = value;
    else dropped.push(key);
  }
  return { details: kept, dropped };
}

/**
 * A member as the log stores them: a per-household SHA-256 of their user id,
 * truncated to 132 bits. Never reversible (a Cognito sub is a random UUID),
 * never comparable across households, and resolvable only by someone holding
 * the user id — which, after an account deletion, nobody does.
 */
export function auditMemberRef(householdId: string, userId: string): string {
  return createHash('sha256')
    .update(`fg-household-audit:v1 ${householdId} ${userId}`)
    .digest('base64url')
    .slice(0, 22);
}

export const auditPartitionKey = (householdId: string): string => `HOUSEHOLD#${householdId}#AUDIT`;
export const AUDIT_SORT_PREFIX = 'AUDIT#';

/** The DynamoDB row for one entry. Pure: id, clock and gap flag are inputs. */
export function buildAuditItem(
  input: RecordHouseholdAuditInput,
  opts: { id: string; now: Date; gapBefore: boolean }
): { item: Record<string, unknown>; dropped: string[] } {
  const occurredAt = opts.now.toISOString();
  const { details, dropped } = sanitizeAuditDetails(
    input.kind,
    input.details as unknown as Record<string, unknown>
  );
  const item: Record<string, unknown> = {
    PK: auditPartitionKey(input.householdId),
    SK: `${AUDIT_SORT_PREFIX}${occurredAt}#${opts.id}`,
    entityType: 'HouseholdAuditEntry',
    id: opts.id,
    householdId: input.householdId,
    kind: input.kind,
    occurredAt,
    actorType: input.actor.type,
    details,
    ttl: Math.floor(opts.now.getTime() / 1000) + AUDIT_RETENTION_DAYS * 24 * 60 * 60,
  };
  if (input.actor.type === 'member') {
    item.actorRef = auditMemberRef(input.householdId, input.actor.userId);
  }
  if (input.targetUserId) {
    item.targetRef = auditMemberRef(input.householdId, input.targetUserId);
  }
  if (opts.gapBefore) item.gapBefore = true;
  return { item, dropped };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Who an entry names, as the admin page shows it. */
export type AuditParty =
  { type: 'member'; name: string } | { type: 'former_member' } | { type: 'stripe' };

export interface HouseholdAuditEntryView {
  id: string;
  /** A kind this server knows, or a newer one passed through for the client's fallback. */
  kind: string;
  occurredAt: string;
  actor: AuditParty;
  target: AuditParty | null;
  details: Record<string, AuditDetailValue>;
  /**
   * An earlier audit write in this household failed, so something may be
   * missing between this entry and the one before it. A dropped write must
   * not leave the log looking continuous.
   */
  gapBefore: boolean;
}

/**
 * Resolve a stored row against the household's current roster. The roster is
 * a settled read the caller has already made: a failed roster read must fail
 * the request, never turn every actor into "former member".
 */
export function toAuditEntryView(
  item: Record<string, unknown>,
  householdId: string,
  roster: ReadonlyArray<{ userId: string; name: string }>
): HouseholdAuditEntryView {
  const names = new Map(roster.map((m) => [auditMemberRef(householdId, m.userId), m.name]));
  const party = (ref: unknown): AuditParty => {
    const name = typeof ref === 'string' ? names.get(ref) : undefined;
    return name !== undefined ? { type: 'member', name } : { type: 'former_member' };
  };
  const details: Record<string, AuditDetailValue> = {};
  const rawDetails = item.details;
  if (rawDetails && typeof rawDetails === 'object') {
    // Re-checked on the way out: rows are a persistence boundary, and a value
    // that is not safe to store is not safe to serve either.
    for (const [key, value] of Object.entries(rawDetails as Record<string, unknown>)) {
      if (isSafeDetailValue(value)) details[key] = value;
    }
  }
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    id: text(item.id),
    kind: text(item.kind),
    occurredAt: text(item.occurredAt),
    actor: item.actorType === 'stripe' ? { type: 'stripe' } : party(item.actorRef),
    target: item.targetRef === undefined ? null : party(item.targetRef),
    details,
    gapBefore: item.gapBefore === true,
  };
}

/** Whether a row is past its retention. DynamoDB's TTL sweep can lag by days. */
export function isAuditItemExpired(item: Record<string, unknown>, now: Date): boolean {
  return typeof item.ttl === 'number' && item.ttl <= Math.floor(now.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Billing: what the Stripe webhook's recorded status means for the log
// ---------------------------------------------------------------------------

const DUNNING_STATUSES = new Set(['past_due', 'unpaid']);
const RECOVERABLE_STATUSES = new Set(['past_due', 'unpaid', 'incomplete']);

export type BillingAuditEntry = {
  [K in 'billing.plan_changed' | 'billing.payment_failed' | 'billing.payment_recovered']: {
    kind: K;
    details: HouseholdAuditDetailsByKind[K];
  };
}['billing.plan_changed' | 'billing.payment_failed' | 'billing.payment_recovered'];

/**
 * The entries one applied Stripe event produces, read from the fields the
 * webhook just recorded (`status`, `planId`) and the event's own immutable
 * `previous_attributes`. Pure — it takes the event type and those two things,
 * so nothing else on the event (customer, email, card, invoice) can reach it.
 *
 *   - checkout completed                   → plan_changed (via checkout)
 *   - subscription updated, status moved
 *       into past_due/unpaid               → payment_failed
 *       from past_due/unpaid/incomplete
 *       to active                          → payment_recovered
 *   - subscription updated, price moved    → plan_changed (via subscription)
 *   - subscription deleted                 → plan_changed (via ended)
 *
 * `customer.subscription.created` records nothing: it accompanies every
 * checkout this app creates, and the checkout event already said it.
 */
export function billingAuditEntries(
  eventType: string,
  previousAttributes: Record<string, unknown> | null | undefined,
  fields: { planId?: string; status?: string }
): BillingAuditEntry[] {
  const plan = fields.planId;
  if (!plan) return [];
  const status = fields.status;

  switch (eventType) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return [{ kind: 'billing.plan_changed', details: { plan, status, via: 'checkout' } }];
    case 'customer.subscription.deleted':
      return [{ kind: 'billing.plan_changed', details: { plan, status, via: 'ended' } }];
    case 'customer.subscription.updated': {
      const entries: BillingAuditEntry[] = [];
      const previous = previousAttributes ?? {};
      if (status && ('items' in previous || 'plan' in previous)) {
        entries.push({
          kind: 'billing.plan_changed',
          details: { plan, status, via: 'subscription' },
        });
      }
      const previousStatus = typeof previous.status === 'string' ? previous.status : undefined;
      if (status && previousStatus !== undefined && previousStatus !== status) {
        if (DUNNING_STATUSES.has(status) && !DUNNING_STATUSES.has(previousStatus)) {
          entries.push({ kind: 'billing.payment_failed', details: { plan, status } });
        } else if (status === 'active' && RECOVERABLE_STATUSES.has(previousStatus)) {
          entries.push({ kind: 'billing.payment_recovered', details: { plan, status } });
        }
      }
      return entries;
    }
    default:
      return [];
  }
}
