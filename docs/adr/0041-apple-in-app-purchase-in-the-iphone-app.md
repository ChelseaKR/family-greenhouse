# 0041 — Apple In-App Purchase in the iPhone app, beside Stripe, off by default

**Status:** Proposed

**Date:** 2026-10-24

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0027](0027-no-card-garden-trial.md) (the no-card trial),
[ADR 0028](0028-gift-subscriptions.md) (gifts, the pattern this follows),
[ADR 0034](0034-the-app-stays-signed-in.md) (never drive a plugin without its native half),
[ADR 0010](0010-settled-read-states.md) (a read that failed is not an answer).

## Context

On 2026-10-24 the owner chose Apple In-App Purchase for the Family Greenhouse iPhone app (roadmap
decision A), replacing the 2026-10-04 position of shipping with no purchase in the app and relying
on Guideline 3.1.3(f). Garden ($4.99 a month) and Greenhouse ($9.99 a month) are digital
subscriptions, so inside the app Guideline 3.1.1 allows only In-App Purchase, and the app may show
no other price and no pointer to another way to pay.

The website keeps selling through Stripe, which has charged real cards since 2026-09-01. A
household can therefore pay in two places, and the risks are a household paying twice, and two
systems each believing they decide its plan.

## Decision

1. **One entitlement, read in one place.** The household METADATA row stays the source of truth.
   Apple's state is one map on it, `appStore` (`planId`, `productId`, `expiresAt`, `willRenew`,
   `revoked`, `environment`), plus two internal attributes: `appStoreOriginalTransactionId` (which
   Apple subscription the map describes) and `appStoreSignedDate` (ordering).
   `getEntitledPlan` and `getEntitledPlanForIssuedGrant` (models/plans.ts) raise a household to the
   App Store tier while `appStoreState` is `active`, under the lifetime floor and the gift, exactly
   as a Stripe subscription is read. Stripe never writes `appStore`; the App Store path never writes
   a Stripe field. A household paying through both gets the stronger tier, never a sum.

2. **Apple's billing states fold into one date.** `expiresAt` is the later of the transaction's
   `expiresDate` and a billing grace period's end, or the revocation date after a refund or revoke.
   Access is derived on every read (`now < expiresAt` and not revoked), like the trial and gifts.
   A missed renewal notification ends access at the old expiry rather than keeping it forever, and
   the app's own sync (decision 5) or Apple's retry brings it back.

3. **Trust only Apple's root.** Every signed transaction, renewal info and App Store Server
   Notification v2 payload is a JWS whose `x5c` chain must end at the pinned Apple Root CA - G3
   (SHA-256 `63:34:3A:...:91:79`), with each certificate signed by the next, Apple's two marker
   extensions present, the chain valid at the payload's `signedDate`, and the ES256 signature valid
   under the leaf. `services/appStoreJws.ts` does this with `node:crypto` alone, so the billing
   Lambda gains no dependency. OCSP is not checked (Apple's own library leaves it off by default).
   The bundle id must be `net.familygreenhouse.app`; production notifications must name app 6812185914. Production and Sandbox are both accepted, because App Review buys in Sandbox against
   the production server; `APP_STORE_ENVIRONMENTS` narrows it later. Xcode-signed transactions are
   never accepted by the server.

4. **Which household.** Before the purchase sheet opens, `POST /billing/app-store/purchase-intent`
   returns the household's `appAccountToken` (a UUID created once, with a lookup row
   `APPSTORE_TOKEN#<uuid>`), which StoreKit stamps into the transaction. The first verified
   transaction binds Apple's `originalTransactionId` to the household (`APPSTORE_TXN#<id>`, written
   once). After that the binding decides for the app's posts and Apple's notifications alike, and a
   restore on another household reports `APP_STORE_LINKED_ELSEWHERE` rather than moving it. A
   subscription with no token (an offer code redeemed in the App Store) goes to the first household
   that posts it, signed in.

5. **Two paths in, both idempotent.** The app posts what StoreKit holds
   (`POST /billing/app-store/transactions`) after a purchase, on Restore purchases, at launch, and
   for every `Transaction.updates` event, and finishes a transaction only after the server answered.
   Apple posts notifications to `POST /billing/app-store/notifications`. Both re-derive the map from
   Apple's current data, and the write is conditioned on `appStoreSignedDate`, so a delayed or
   repeated delivery is harmless and there is no event ledger.

6. **No household pays twice.** The purchase intent refuses (409, with a code) a household that has
   a live Stripe subscription, an active App Store subscription (changes go through Apple's Manage
   Subscriptions sheet), or a lifetime purchase or running gift that already includes the tier. The
   web plan checkout refuses (409 `APP_STORE_SUBSCRIBED`) while an App Store subscription is active,
   whatever the switch says. A second Apple subscription from another Apple ID on the same home is
   not merged: the write is refused while the first is live and logged
   (`app_store_second_subscription_on_household`), and a household found paying both Stripe and
   Apple is logged (`app_store_and_stripe_both_live`), so the owner can refund one. Neither can be
   prevented outright: a person can always buy from a second device or account.

7. **The no-card trial stops counting** once any App Store state exists, active or not, the way it
   does for Stripe state: buying during the trial is how it converts, and a lapsed App Store
   household is not handed the trial back.

8. **In the app, only Apple's price.** The plans card (`AppStorePlans`) shows StoreKit's
   `displayPrice` and display name, Apple's purchase sheet, Restore purchases, Apple's Manage
   Subscriptions sheet, the auto-renewal terms and links to the Terms of Use and Privacy Policy
   (Guideline 3.1.2). A household that pays another way sees that it has a paid plan, and nothing
   that names the other way. `LockedFeature` names the tier with no price and sends an admin to the
   plans card. The catalog's prices are never rendered in the app.

9. **Off by default, three switches.** The server routes answer 404 unless
   `APP_STORE_BILLING_ENABLED` is exactly `"1"` and payments are available (Terraform
   `app_store_billing_enabled`, default `"0"`). The app shows purchases only when the build sets
   `VITE_APP_STORE_PURCHASES=true` and the binary registers the NativePurchases plugin. Turning a
   switch off never removes a recorded App Store entitlement.

10. **Products.** One subscription group, "Family Greenhouse plans", with
    `net.familygreenhouse.app.greenhouse.monthly` (level 1, $9.99) and
    `net.familygreenhouse.app.garden.monthly` (level 2, $4.99), no introductory offer, not Family
    Sharing. The local StoreKit configuration `frontend/ios/App/App/FamilyGreenhouse.storekit`
    carries the same, and tests hold the backend catalog, the frontend and that file together.

## Consequences

- Apple keeps 15% (Small Business Program). The price stays the same in both places.
- Upgrades, downgrades and cancellations for App Store households happen in Apple's sheet, never in
  the Stripe portal; the website tells such a household to change it in iPhone settings.
- The 2026-10-04 "no purchase in the app" rules in docs/mobile.md still hold whenever the build
  switch is off, which is the default.
- Not built: Android (Google Play Billing), annual App Store products, introductory offers, the App
  Store Server API (refund lookups, `Get Transaction History`), and consumption responses.
- Known simulator limit: on the iOS 26.5 simulator, StoreKit Testing purchases can fail with
  `SKInternalErrorDomain Code=3`, an Apple bug. The app reports the failure; test purchases on a
  device or in Sandbox.
