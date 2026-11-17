# 0044 — The iPhone app does not spend identification packs bought on the website

**Status:** Accepted

**Date:** 2026-11-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0019](0019-identification-top-up-packs.md) (packs),
[ADR 0041](0041-apple-in-app-purchase-in-the-iphone-app.md) (In-App Purchase in the iPhone app),
[ADR 0042](0042-garden-repriced-to-2-99-with-identification-sold-only-by-the-pack.md) (Garden includes no identification),
[ADR 0043](0043-the-ios-app-is-iphone-only-for-its-first-review.md) (iPhone only for the first review).

## Context

The website sells a one-time pack of plant identification credits through Stripe (ADR 0019). The
iPhone app sells only the three subscriptions, and does not sell the pack. Until now a request from
the iPhone app spent pack credits like any other request, once the plan's monthly allowance was
used up.

App Review Guideline 3.1.3(b) lets a multiplatform app unlock what was bought elsewhere only if the
app also sells it as an In-App Purchase. Plans meet that; the pack does not. The submission's
review notes would have had to disclose this, on a first review.

## Decision

1. **`POST /plants/identify` takes an optional `useTopUpCredits` boolean,** default true. When it is
   false, the handler reserves against the plan's monthly allowance only and hands
   `reserveIdentification` no household, so no credit is read or spent. A refusal then carries
   `credits: null` (not consulted) and no pack offer.
2. **The iPhone app sends `useTopUpCredits: false`** (`plantService.identifyPlant`, keyed on
   `getNativePlatform() === 'ios'`). The app already showed no pack offer and no price; it now also
   spends none.
3. **The website and the Android app send nothing new,** so their behavior is unchanged. Android
   is not in a store yet; it gets its own decision before Google Play review.
4. The field can only take credits away from the caller. A client that sends false gains nothing,
   so it needs no proof of where the request came from.

## Consequences

- A household that bought a pack on the website uses it on the website. In the iPhone app,
  identification stops when the plan's allowance is spent (Garden has none; Greenhouse has 100 a
  month; Seedling 1), with the existing "isn't included" message.
- The review notes say nothing about packs, and the app unlocks nothing that it does not also sell.
- The credits stay where they are, so a later decision can sell the pack in the app as a
  consumable In-App Purchase and send true again.
- An iPhone build older than 0.52.0 still spends credits. No such build is on the App Store.
