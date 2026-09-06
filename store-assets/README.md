# Store release assets

Generated artwork and reviewed English metadata for the iOS App Store and
Google Play. Run `npm run brand:render --workspace frontend` after changing a
source SVG, then `npm run mobile:validate` before building a release.

Screenshots must come from the final synchronized build and must not include
real user data. Reviewer credentials and signing material are intentionally
not stored here.

`npm run store:screenshots --workspace frontend` regenerates all twelve
frames. It captures the **store-demo household** — three named members, eight
plants across five rooms, one overdue job nobody has claimed, four due today
across three people, and a month of care history — not the mock backend's
default one-plant `test@example.com` fixture. That household lives in
`backend/src/local-server-store-demo.ts` and is seeded only when the API
starts with `SEED_STORE_DEMO=1`, which `tests/e2e/playwright.store.config.ts`
does; the spec probes for the demo account before capturing, so a dev server
already holding port 4000 without the flag fails the run instead of quietly
reproducing the old frames. Every name, address and plant in it is invented,
and the addresses are `@example.com` — permanently unregistrable, so no frame
can ever show a real person's account.

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

- **No plant photographs in any frame.** Every plant in the store-demo
  household has no `imageUrl`, so all eight cards, the plant-detail hero and
  the phone plant-detail frame — which is mostly hero image — render the brand
  placeholder, and `PhotoTimeline` (which needs two photos) never appears. The
  fixture supports photos: `db.photos` rows pointing at `/mock-images/…`
  objects would populate the strip. What it cannot supply is a photograph.
  Inventing one and presenting it as this household's own plant is the thing
  the no-real-user-data rule exists to prevent, and a synthetic gradient
  standing in for a photo would read as a placeholder anyway. Real photos of
  real plants, consented and owned, are what this needs — after which the
  seed's `imageUrl` and `db.photos` are the two places to put them.
- **No caption overlays.** These are raw device frames. Both stores allow
  captioned marketing frames and nearly every competitor uses them.
- **No Android tablet screenshots.** iPad frames exist, so the app runs on a
  tablet. Play surfaces a large-screen quality warning and down-ranks tablet
  and Chromebook surfacing without 7"/10" frames.
- **Four frames each.** Apple allows 10, Play allows 8.
- **English-only listing for a bilingual app.** `frontend/src/i18n/locales/es`
  is a complete catalog at key parity with English, enforced by the i18n
  gates, but this directory only has `en-US.json`. Both stores localize
  listings independently of the binary, so a Spanish listing is reach the app
  has already paid for and is not collecting. It needs a native-Spanish
  reviewer rather than a machine translation — a listing is the one surface
  where awkward Spanish is the whole first impression.

## Not blocked on anything in this directory

The remaining blockers are accounts and hardware, not assets: the Apple
Developer Program ($99/yr) and Play Console ($25) enrollments, an Android
upload keystore, Apple team signing, a seeded reviewer account, and physical
device smoke tests. Google Play also requires a new personal account to run a
closed test with at least 12 testers for 14 days before production access is
granted, so that clock should start before anything here is polished further.
See `docs/mobile-release-checklist.md`.
