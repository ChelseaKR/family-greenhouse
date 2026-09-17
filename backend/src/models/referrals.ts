/**
 * Refer-a-friend (ADR 0029): a distinct growth loop from the household
 * invite (`services/householdService.ts`'s `createInvite`/`addMember`).
 *
 * A household invite brings someone into YOUR household. A referral brings
 * someone into the app who starts their OWN new household — the two are
 * different products even though both are "send someone a link":
 *
 *   - Household invite: `HouseholdInvite` (models/types.ts), a 128-bit code
 *     minted per invite, redeemed by `joinHousehold`, adds a MEMBER row to
 *     an EXISTING household. No incentive attached.
 *   - Referral: one code per USER (this module), redeemed at most once ever
 *     per new account, applied only to that account's FIRST household
 *     (`households/handler.ts`'s `isFirstHousehold`). Grants BOTH sides a
 *     free month of Garden.
 *
 * The incentive reuses the exact mechanism the no-card trial (ADR 0027) and
 * gift subscriptions (ADR 0028) already use: two attributes on a household's
 * METADATA row, `giftPlanId` / `giftEndsAt`, read by `giftState` in
 * `models/plans.ts`. Nothing new is added to entitlement resolution — a
 * referral bonus IS a gift, as far as `getEntitledPlan` is concerned, so
 * `services/billing.ts`'s existing "no Stripe path may write or clear these"
 * guarantee (ADR 0028) covers it for free. The only addition is an optional
 * `giftSource` attribute (billing.ts), carried through to GET /billing/me,
 * so the client can say "referral bonus" instead of "gift redeemed" — it has
 * no bearing on what tier a household resolves to or for how long.
 *
 * Pure module: no DynamoDB, no Stripe client, no logging. Persistence lives
 * in `services/referralCodes.ts`; the policy decisions (who is eligible, the
 * anti-self-referral guard) live in `services/referrals.ts` — the same
 * three-way split `giftSubscriptions.ts` / `giftCodes.ts` / `plans.ts` uses.
 */
import { randomBytes } from 'node:crypto';
import type { GiftablePlanId } from './giftSubscriptions.js';

/** The tier a referral bonus grants, and for how long. One month of Garden:
 *  generous enough to be worth sharing, cheap enough to give away twice (once
 *  per side) on a household that costs ~$0 marginal to serve at this tier
 *  (ADR 0012's numbers are for identify/leaf-health/chat, none of which a
 *  brand-new household has used yet). Not Greenhouse: that tier's AI-cost
 *  ceiling is real money (ADR 0012), and a referral bonus must not be a way
 *  to grind free access to it. */
export const REFERRAL_BONUS_PLAN_ID: GiftablePlanId = 'garden';
export const REFERRAL_BONUS_MONTHS = 1;

/**
 * Same alphabet as gift codes (`models/giftSubscriptions.ts`): Crockford
 * base32, no I/L/O/U, so a code read aloud or typed from a card is
 * unambiguous. Shorter body (10 symbols = 50 bits) and a different prefix —
 * a referral code is not a bearer credential redeemable for money by
 * whoever holds it the way a gift code is (redeeming one benefits the
 * REFERRER, who did nothing to protect it beyond sharing it on purpose); 50
 * bits is already far past any realistic guessing attack, and the real
 * guard against self-referral abuse is `detectSelfReferral` below, not
 * secrecy of the code.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PREFIX = 'RF';
const CODE_BODY_LENGTH = 10;
const CODE_BODY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** Canonical form: `RF` + 10 alphabet symbols, no separators. */
export type ReferralCode = string;

export function generateReferralCode(): ReferralCode {
  const bytes = randomBytes(CODE_BODY_LENGTH);
  let body = '';
  for (let i = 0; i < CODE_BODY_LENGTH; i += 1) body += CODE_ALPHABET[bytes[i] & 31];
  return `${CODE_PREFIX}${body}`;
}

/**
 * Canonicalise what a person typed or a query param carried: case, spaces,
 * dashes, and the Crockford confusables (`O`→`0`, `I`/`L`→`1`). Returns null
 * for anything that is not a well-formed code, so a lookup never runs
 * against arbitrary input — mirrors `normalizeGiftCode`.
 */
export function normalizeReferralCode(input: unknown): ReferralCode | null {
  if (typeof input !== 'string') return null;
  const stripped = input
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!stripped.startsWith(CODE_PREFIX)) return null;
  const body = stripped.slice(CODE_PREFIX.length);
  if (!CODE_BODY_PATTERN.test(body)) return null;
  return `${CODE_PREFIX}${body}`;
}

/** `RF-XXXXX-XXXXX` — the shape a person reads and shares. */
export function formatReferralCode(code: ReferralCode): string {
  const body = code.slice(CODE_PREFIX.length);
  return [CODE_PREFIX, ...(body.match(/.{1,5}/g) ?? [])].join('-');
}

// ---------------------------------------------------------------------------
// Anti-abuse: is this "referral" plausibly the same person on both ends?
// ---------------------------------------------------------------------------

/**
 * Free/shared mailbox providers where two different people routinely share a
 * domain. A domain MATCH here proves nothing about identity, so it is never
 * treated as a self-referral signal on its own — only an exact normalized
 * address match is (see `detectSelfReferral`).
 */
const SHARED_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'zoho.com',
]);

/**
 * `email`, normalized for a same-person comparison: lower-cased, and with a
 * `+tag` suffix on the local part stripped (`chelsea+ref1@gmail.com` and
 * `chelsea+ref2@gmail.com` are the same inbox — the classic self-referral
 * loophole a plain string-equality check on raw addresses would miss, since
 * Cognito treats them as two distinct, both-valid account emails).
 *
 * Deliberately does NOT do Gmail's dot-insensitivity or other provider-
 * specific canonicalization: that is real fraud-detection infrastructure,
 * disproportionate for a low-volume, pre-revenue product (see module doc).
 * `+tag` stripping catches the one loophole cheap enough to be worth
 * closing and common enough to be worth closing.
 */
export function normalizeEmailForMatch(email: string): {
  local: string;
  domain: string;
  full: string;
} {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  const localRaw = at >= 0 ? lower.slice(0, at) : lower;
  const domain = at >= 0 ? lower.slice(at + 1) : '';
  const local = localRaw.split('+')[0];
  return { local, domain, full: `${local}@${domain}` };
}

export type SelfReferralReason =
  /** Same normalized address (after `+tag` stripping) on both sides. */
  | 'same_email'
  /** Same domain on both sides, and it is NOT a shared/free provider — a
   *  private or workplace domain used by "two different people" who signed
   *  up minutes apart via one person's referral link is the strongest
   *  low-cost signal this module has for "this is one household, not two". */
  | 'shared_custom_domain';

/**
 * Whether a referral between these two email addresses looks like the same
 * person on both ends. `null` means no concern: two different addresses on
 * two different domains, or the same shared/free provider used by two
 * plausibly-different people (the overwhelming common case — most signups
 * share gmail.com with most referrers, and that alone proves nothing).
 *
 * Proportionate, not exhaustive (see module doc): this is the one concrete
 * guard the feature ships with. It does not attempt device fingerprinting,
 * IP correlation, or payment-method matching — the last of those has no
 * payment method to compare at signup time in the first place (the no-card
 * trial and the referral bonus are both card-free), and building a live
 * Stripe-card-fingerprint cross-check for a feature with zero paying
 * customers today would be exactly the enterprise fraud infrastructure this
 * is deliberately not.
 */
export function detectSelfReferral(
  referrerEmail: string,
  newSignupEmail: string
): SelfReferralReason | null {
  const a = normalizeEmailForMatch(referrerEmail);
  const b = normalizeEmailForMatch(newSignupEmail);
  if (!a.domain || !b.domain) return null;
  if (a.full === b.full) return 'same_email';
  if (a.domain === b.domain && !SHARED_EMAIL_DOMAINS.has(a.domain)) return 'shared_custom_domain';
  return null;
}
