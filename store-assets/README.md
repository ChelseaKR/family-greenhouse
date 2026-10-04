# Store release assets

Generated artwork and reviewed English metadata for the iOS App Store and
Google Play. Run `npm run brand:render --workspace frontend` after changing a
source SVG, then `npm run mobile:validate` before building a release.

Screenshots must come from the final synchronized build and must not include
real user data. Reviewer credentials and signing material are intentionally
not stored here.

There are two capture scripts, and both use the **store-demo household**:
three named members, eight plants across five rooms, one overdue job nobody
has claimed, four due today (three held by three different people and one
still up for grabs), and a month of care history. That household lives in
`backend/src/local-server-store-demo.ts` and is seeded only when the API
starts with `SEED_STORE_DEMO=1`. Every name, address and plant in it is
invented, and the addresses are `@example.com`, which can never be
registered, so no frame can show a real person's account. Both scripts sign
in as the demo account before capturing and fail, naming the flag, if a
server already on port 4000 doesn't have it.

- **iPhone 6.9-inch (`app-store/iphone-6.9/`, 8 frames): the iOS app
  itself.** `npm run store:screenshots:ios --workspace frontend` builds this
  checkout for the iOS Simulator, installs it fresh on an iPhone 17 Pro Max
  (1320 x 2868) with light appearance and Apple's 9:41 status bar, and
  captures the real app, native tab bar and navigation bar included. See
  "Regenerating the iPhone frames" below.
- **iPad 13-inch and Google Play phone (4 frames each): the website.**
  `npm run store:screenshots --workspace frontend` captures the web app in
  Playwright at each store's size (`tests/e2e/playwright.store.config.ts`).
  These still show the web layout with the menu drawer, which is what the
  iPad and Android apps show today.

### Regenerating the iPhone frames

On a Mac with Xcode and the iOS 26 simulator runtime:

1. Stop anything on port 4000 that wasn't started with `SEED_STORE_DEMO=1`.
   The script starts the mock API itself when the port is free, and stops it
   when it's done.
2. Run `npm run store:screenshots:ios --workspace frontend`. It runs
   `npm run build` and `cap sync ios`, builds a Debug simulator app with
   `xcodebuild`, boots the simulator if it's off (and shuts it down again
   afterward), and writes the PNGs here. Pass `--udid <id>` if you have more
   than one iPhone 17 Pro Max simulator, or a different 6.9-inch iPhone.
3. Look at every frame before committing it.

How it drives the app: `frontend/scripts/store-shots/tour.js` is copied into
the synced web folder of that one simulator build (`ios/App/App/public`,
which git ignores and every `cap sync` rewrites) and removed again as soon as
Xcode has copied it. It is never in `src/`, `dist/` or a release build. In
the app, it types the demo sign-in into the real form, then opens each route
in `frontend/scripts/store-shots/shots.mjs` (the shot list, in listing
order) and waits for it to settle. The native bars follow the route as they
do for a tap. Before the frames are taken, the script also creates one
plant-sitter link ("Long weekend") through the same API the app calls,
because frame 07 shows the page that link opens. Each PNG is checked for
size and saved without an alpha channel.

| Frame              | What it shows                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-plants`        | The Plants tab: large title, the ⋯, filter and + buttons in the native bar, the search field, then "Needs care" (5 plants, each with who holds it and a round water button) and "Coming up" (3). |
| `02-home`          | Home: the large title, the day's counts, and "To do now" with the overdue Peace Lily up for grabs and today's jobs held by named members.                                                        |
| `03-plant-detail`  | The Monstera, opened from the list: back chevron and ⋯ menu, the status card ("Water today", held by you, last done by Marisol Reyes, Watered and Snooze), its house rule and note.              |
| `04-plant-care`    | Further down the same page: the curated care tips for _Monstera deliciosa_ and its weekly watering task with its streak.                                                                         |
| `05-tasks`         | Tasks, with the overdue job marked "Up for grabs" and the Claim, Ask family and Done actions.                                                                                                    |
| `06-household`     | Household: who did the care in the last 30 days, who holds what now, and the four jobs nobody holds.                                                                                             |
| `07-sitter`        | The page a plant-sitter link opens: what needs doing and in which room, with Done buttons and no account, until the link expires.                                                                |
| `08-notifications` | Settings, Notifications: the email reminder, weekly digest and household email settings as switches.                                                                                             |

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
- **The iPad and Play frames still show the web layout with the menu
  drawer.** Only the iPhone set comes from the native app.
- **No Android tablet screenshots.** iPad frames exist, so the app runs on a
  tablet. Play surfaces a large-screen quality warning and down-ranks tablet
  and Chromebook surfacing without 7"/10" frames.
- **Four iPad and four Play frames.** Apple allows 10 per size and Play
  allows 8. The iPhone set has 8.
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
