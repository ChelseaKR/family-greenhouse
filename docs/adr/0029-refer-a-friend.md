# 0029 — Refer-a-friend is a household-invite look-alike that grants a gift, not a household invite with a prize bolted on

**Status:** Proposed

**Date:** 2026-09-16

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0027](0027-no-card-garden-trial.md) (the app-side entitlement shape this
copies); [ADR 0028](0028-gift-subscriptions.md) (the `giftPlanId`/`giftEndsAt` mechanism this
reuses outright, and the redemption-policy split this mirrors);
[`docs/billing.md`](../billing.md) § _The no-card Garden trial_.

## Context

Every real use of this app already involves inviting someone — a household that works is a
household with more than one person in it. That makes referral growth unusually cheap to build
here: the "invite someone" moment already exists in the product (`householdService.createInvite`
/ `joinHousehold`), it just currently has no reason to reward the inviter, because it only ever
adds someone to the INVITER's own household.

A referral is a different event: someone who was not going to sign up at all starts their OWN
new household because an existing user pointed them at the app. That is worth rewarding on both
sides — it is the one growth channel this product can run without a campaign, an ad budget, or a
weekly hour of anyone's time — but it must not be confused with, or layered onto, the household
invite mechanism. A household invite and a referral answer different questions ("who is in MY
household" vs. "who did I bring to the app") and conflating them would mean a household's fourth
member quietly starting to earn the admin free months, or a referral code silently able to add
someone to a stranger's household.

## Decision

1. **A referral code is per-USER, not per-invite, and is a look-alike of a gift code
   (`models/giftSubscriptions.ts`) — not of a household invite.** Crockford base32,
   `RF`-prefixed, get-or-create (one code per account for life, snapshotting the household that
   was active the first time it was minted). Unlike a gift code it is NOT hashed at rest: a gift
   code is a bearer credential redeemable for money by whoever holds it, and secrecy is the whole
   guard; a referral code is meant to be shared publicly and the guard against abuse is
   `detectSelfReferral`, not concealment.

2. **The bonus is one month of Garden, on BOTH sides, using the exact `giftPlanId` /
   `giftEndsAt` fields ADR 0028 already put on the household METADATA row.** Nothing new joins
   entitlement resolution: `giftState` / `withGift` in `models/plans.ts` are untouched, so a
   referral bonus IS a gift as far as every existing reader is concerned, and inherits ADR 0028's
   guarantee that no Stripe path may write or clear it. The only addition is an optional
   `giftSource: 'purchase' | 'referral'` attribute, display-only, so GET /billing/me and the
   "Refer a friend" panel can say which one it was; it has no bearing on what tier a household
   resolves to.

3. **Redemption rides `POST /households`, not a separate "redeem" endpoint.** A referral is
   only meaningful for a genuinely NEW account's FIRST household
   (`households/handler.ts`'s existing `isFirstHousehold`) — a household invite already exists for
   joining someone else's, and a Greenhouse user's second home is not a new person arriving. The
   grant is decided (`services/referrals.ts#resolveReferralGrant`) before the household is
   created and, when accepted, rides the SAME transaction as the household row and the no-card
   trial claim (`householdService.createHousehold`) — a household can never exist with a referral
   accepted but no bonus applied. A bad, unknown, expired, or self-referred code is never an
   error: it resolves to "no bonus", exactly like an unconfigured gift tier resolves to "not for
   sale" rather than a 500.

4. **The referrer's side is credited separately, after, best-effort
   (`services/referrals.ts#creditReferralAfterSignup`).** It touches a DIFFERENT household's row
   and must not be able to fail the signup that already succeeded. It re-reads the new
   household's own row first — an authoritative check, not an assumption, because the one-claim-
   per-account guard in `createHousehold` can (rarely) fall back to a plain create with no bonus,
   and this must not credit a referrer for a bonus that was never actually granted. The referrer's
   own grant reuses ADR 0028's exact household-side condition (no live Stripe subscription, no
   gift already running, no lifetime floor at or above it) as a single conditional update, and a
   refusal is recorded on the referrer's own referral-history list rather than silently dropped.

5. **Anti-abuse is one proportionate guard, not a fraud platform.** `detectSelfReferral`
   (`models/referrals.ts`) blocks an exact normalized-address match (with `+tag` stripping — the
   common self-referral alias trick) and a shared PRIVATE domain on both sides; it deliberately
   does NOT block two different people who happen to share a free/shared provider (gmail.com and
   friends), which would refuse the overwhelming majority of legitimate referrals. Payment-method
   matching is explicitly out of scope: there is no card to compare at signup time (both the
   no-card trial and the referral bonus are card-free), and this product has zero paying
   customers as of this decision — building live Stripe-fingerprint cross-checks for that would be
   exactly the enterprise fraud infrastructure a low-volume, pre-revenue product does not need yet.

6. **The referral link is `/register?ref=CODE`, distinct from a household-invite link
   (`/join/CODE`) by both path and purpose.** Carried across the register → confirm-email →
   onboarding hops via sessionStorage (`features/referrals/pendingReferralCode.ts`), the same fix
   `features/plants/pendingShareCode.ts` already uses for the same reason (those steps navigate on
   router state, not the query string). No dedicated public landing page: the register page
   already works logged-out, and a second public page for a free (never-paid) mechanic was not
   worth the surface.

7. **The "Refer a friend" settings panel is NOT gated by `isNativeApp()`.** Every existing
   `isNativeApp()` gate (BillingSettings, PricingPage, GiftLandingPage, the identify top-up card)
   hides a real Stripe Checkout redirect — a payment flow App Store guideline 3.1.1 requires to go
   through Apple's IAP. Nothing on this panel is a payment: the bonus is granted server-side with
   no checkout, no price shown as payable, and no button that starts one. There is nothing here for
   3.1.1 to apply to, and hiding it would block a legitimate free growth loop from iOS users for no
   guideline reason. `ReferralSettings.test.tsx`'s native-shell suite is what actually enforces
   that this stays true — it asserts the panel renders on native AND that its only control is
   "Copy link".

## Alternatives considered

**A stackable/renewable per-referral credit ledger (N months = N referrals) — rejected for
now.** ADR 0028's gift shape is a single floor, not a balance; building a ledger that stacks would
mean touching `models/plans.ts`'s entitlement resolution, which this decision specifically avoids.
One month per event, non-stacking (a referral resolved while a gift already runs is simply
refused, recorded as `skipped`), is the proportionate first cut.

**Crediting the referrer inside the SAME transaction as the new household — rejected.** The two
households are different DynamoDB partitions; a single cross-partition transaction would mean a
referrer's ineligibility (already subscribed, already gifted) could fail the NEW user's signup,
which is not a decision the new user has any way to see coming or fix.

**Requiring the referred signup's payment method to differ from the referrer's — deferred.**
See Decision §5. Revisit once the product has paying customers and Stripe cards to compare.

**A public referral landing page with the referrer's name shown — rejected.** This product's own
incident history includes plant `notes` leaking through public token surfaces in one day; showing
a referrer's identity on an unauthenticated page for a feature that does not need it was not worth
adding a new one.

## Consequences

- **`GET /me/referral` is a new route** (`infrastructure/modules/api/main.tf`), authenticated,
  in the existing `me` Lambda group — no new function, no new env var, no new Stripe object.
- **The local dev server mints a code but cannot simulate redemption or the anti-abuse
  guard** — same posture ADR 0028 already accepted for gift codes; a test seeds `referrals`
  directly on the in-memory user, same as it seeds `giftPlanId`/`giftEndsAt` on the household.
- **A household's `gift` in GET /billing/me can now read `source: 'referral'`.** Any client
  that ignores the field keeps working exactly as before; the field is additive and optional.
- **Worst-case AI cost of a referral bonus is Garden's ceiling** ($3.49, ADR 0012's numbers), on
  a household that has used none of its allowances yet — cheaper in practice than a redeemed paid
  gift, which can run on a household with months of history.
