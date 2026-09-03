# Store release assets

Generated artwork and reviewed English metadata for the iOS App Store and
Google Play. Run `npm run brand:render --workspace frontend` after changing a
source SVG, then `npm run mobile:validate` before building a release.

Screenshots must come from the final synchronized build and must not include
real user data. Reviewer credentials and signing material are intentionally
not stored here.

`npm run mobile:validate` runs in CI (the `Lint` job) and checks every size,
every character limit, native/`package.json` version parity, and secrets
hygiene. It is the gate; this file is the context it cannot encode.

## What each field is doing

Both stores index the title far more heavily than the description, and the
App Store does not index the description at all. The listing therefore spends
the title and subtitle on the one thing competitors do not have.

Planta, Greg, Blossom and PictureThis are all single-user trackers. The
differentiator is the shared household: several people, one set of plants,
one care history. A listing that reads "another plant care app" loses to apps
with six-figure review counts, so the household angle carries the title,
subtitle, short description, and the first paragraph of the long description.

The store title (`Family Greenhouse: Plant Care`) deliberately differs from
the Capacitor `appName` (`Family Greenhouse`). `appName` is the home-screen
label, where short wins; the store title is a search field, and the brand
alone contains no term anyone searches for. `validate-store-release.mjs`
enforces the brand as a prefix rather than exact equality for this reason.

## Claims that are load-bearing

Everything in the listing was checked against the shipped native build. Two
constraints are easy to break by accident:

- **Reminders are email-only in the native shells.** Native push is not
  implemented (`docs/mobile.md`), browser push is hidden when `isNativeApp()`,
  and SMS is off in production (`sms_notifications_enabled = ""`). The listing
  says "email reminders" and says push is not in this release. Do not
  shorten that to "reminders" — an app that advertises notifications and
  delivers none is a 2.3.1 rejection and a bad first review.
- **No purchase claims.** The native build hides all billing UI, so the
  listing states the app collects no payment. If in-app purchase is ever
  added, this copy has to change with it.

No ratings, review counts, awards, endorsements, pet-safety claims, or plant
health guarantees appear anywhere in the metadata, and none should be added.

## Known gaps before a submission

The artwork validates, but validating is not the same as selling:

- **The screenshots undersell the product.** They are captured against the
  mock backend's default fixture (`test@example.com`), so the dashboard reads
  "Welcome back, Test", the household has one member, and there is one plant
  and one task. The Tasks screen is more than half empty. Nothing in any of
  the four frames shows a second person, which is the entire pitch. Before
  submitting, seed a store-demo household — a few named members, ~8 plants
  across rooms, a mix of claimed / up-for-grabs / completed tasks, and a photo
  timeline — and re-run `npm run store:screenshots --workspace frontend`.
  "Test" as a user name is also a 2.3.3 risk on its own.
- **No caption overlays.** These are raw device frames. Both stores allow
  captioned marketing frames and nearly every competitor uses them.
- **No Android tablet screenshots.** iPad frames exist, so the app runs on a
  tablet. Play surfaces a large-screen quality warning and down-ranks tablet
  and Chromebook surfacing without 7"/10" frames.
- **Four frames each.** Apple allows 10, Play allows 8.

## Not blocked on anything in this directory

The remaining blockers are accounts and hardware, not assets: the Apple
Developer Program ($99/yr) and Play Console ($25) enrollments, an Android
upload keystore, Apple team signing, a seeded reviewer account, and physical
device smoke tests. Google Play also requires a new personal account to run a
closed test with at least 12 testers for 14 days before production access is
granted, so that clock should start before anything here is polished further.
See `docs/mobile-release-checklist.md`.
