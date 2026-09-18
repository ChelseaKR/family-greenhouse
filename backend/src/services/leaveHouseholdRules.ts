/**
 * The refusal rules for `POST /households/{id}/leave` (#686), pure so the
 * production handler and the local Express mock decide — and word — every
 * refusal identically. Nothing here does I/O.
 *
 * A leave is refused, with nothing changed, in exactly three states:
 *
 *   - LAST_MEMBER — the only member. A household left with plants, history
 *     and possibly a paid plan and nobody in it is never the outcome of a
 *     leave; the household is never ended or deleted by one.
 *   - LAST_ADMIN — the only admin of a household with other members, which
 *     would lock it out of admin. (householdService.removeMember enforces the
 *     same rule transactionally; this is the read-only pre-check that lets the
 *     client word it.)
 *   - BILLING_ACK_REQUIRED — an ADMIN leaving a household whose Stripe
 *     subscription will renew, until they acknowledge it. Leaving never touches
 *     billing, but the card on file may be theirs and they lose access to this
 *     household's billing the moment they leave. Plain members are never asked:
 *     billing is admin-only, so it cannot be theirs to manage.
 */

export const LEAVE_REFUSAL_CODES = {
  lastMember: 'LAST_MEMBER',
  lastAdmin: 'LAST_ADMIN',
  billingAckRequired: 'BILLING_ACK_REQUIRED',
} as const;

export type LeaveRefusalCode = (typeof LEAVE_REFUSAL_CODES)[keyof typeof LEAVE_REFUSAL_CODES];

/** English fallbacks. The web client words each refusal from its own EN/ES
 *  catalog by `details.code`; these reach any other client. */
export const LEAVE_REFUSAL_MESSAGES: Record<LeaveRefusalCode, string> = {
  LAST_MEMBER:
    "You're the only member of this household, so there is nobody to leave it to. Invite someone and make them an admin before you leave. If you want to stop using Family Greenhouse altogether, you can delete your account in Settings → Account instead — that removes you from every household you belong to.",
  LAST_ADMIN:
    "You're the only admin of this household. Make another member an admin on the Household page, then leave.",
  BILLING_ACK_REQUIRED:
    "This household has a paid plan that keeps renewing after you leave — leaving doesn't cancel or change it. If it's billed to your card, update the payment method or cancel the plan in Settings → Billing first: once you've left, you can't reach this household's billing. To leave anyway, confirm that you understand.",
};

/** Stripe statuses under which a subscription charges again unless someone
 *  acts. `past_due` and `unpaid` are still retrying the card on file. */
const RENEWING_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
]);

export interface LeaveSubscriptionView {
  stripeSubscriptionId?: string | null;
  status?: string | null;
  cancelAtPeriodEnd?: boolean | null;
}

/**
 * Will this household's plan charge a card again without anyone acting?
 * A lifetime purchase, a gift, a no-card trial, a cancelled plan and one set
 * to end at period end all answer no: none of them bills the card on file.
 */
export function isRenewingSubscription(subscription: LeaveSubscriptionView): boolean {
  return (
    Boolean(subscription.stripeSubscriptionId) &&
    RENEWING_SUBSCRIPTION_STATUSES.has(subscription.status ?? '') &&
    subscription.cancelAtPeriodEnd !== true
  );
}

export interface LeaveRosterEntry {
  userId: string;
  role: 'admin' | 'member';
}

/**
 * The roster-only refusals, in the order they are checked. Returns null when
 * the roster allows the leave (the billing question is asked separately,
 * because it needs a read the roster checks must not wait on).
 */
export function rosterRefusal(
  leaverId: string,
  members: readonly LeaveRosterEntry[]
): Exclude<LeaveRefusalCode, 'BILLING_ACK_REQUIRED'> | null {
  if (members.length <= 1) return LEAVE_REFUSAL_CODES.lastMember;
  const leaver = members.find((m) => m.userId === leaverId);
  const otherAdmins = members.filter((m) => m.role === 'admin' && m.userId !== leaverId);
  if (leaver?.role === 'admin' && otherAdmins.length === 0) return LEAVE_REFUSAL_CODES.lastAdmin;
  return null;
}
