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
3. Look at every frame before committing it, and commit only the frames whose
   UI changed. The demo's due dates are relative to the day, but the time of
   day still shows: a capture on 2026-10-04 at about 2 p.m. Pacific showed
   today's jobs on the sitter page (07) as "Overdue", while one at 4 a.m. showed
   them as "Due today". Take 07 in the morning.

How it drives the app: `frontend/scripts/store-shots/tour.js` is copied into
the synced web folder of that one simulator build (`ios/App/App/public`,
which git ignores and every `cap sync` rewrites) and removed again as soon as
Xcode has copied it. It is never in `src/`, `dist/` or a release build. In
the app, it types the demo sign-in into the real form, then opens each route
in `frontend/scripts/store-shots/shots.mjs` (the shot list, in listing
order) and waits for it to settle. The native bars follow the route as they
do for a tap. Before the frames are taken, the script sets the household up
through the same API the app calls. Each plant gets its photo (see "Plant
photos" below), and Dana creates one plant-sitter link ("Long weekend"),
because frame 07 shows the page that link opens. Each PNG is checked for
size and saved without an alpha channel.

| Frame              | What it shows                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-plants`        | The Plants tab: large title, the ⋯, filter and + buttons in the native bar, the search field, then "Needs care" (5 plants, each with its photo, who holds it and a round water button) and "Coming up" (3). |
| `02-home`          | Home: the large title, the day's counts, and "To do now" with the overdue Peace Lily up for grabs and today's jobs held by named members.                                                                   |
| `03-plant-detail`  | The Monstera, opened from the list: back chevron and ⋯ menu, its photo, the status card ("Water today", held by you, last done by Marisol Reyes, Watered and Snooze), its house rule and note.              |
| `04-plant-care`    | Further down the same page: the curated care tips for _Monstera deliciosa_ and its weekly watering task with its streak.                                                                                    |
| `05-tasks`         | The Tasks checklist: the filter button in the native bar, Today and Upcoming (5 each), the overdue Peace Lily first, then today's four, each with a check circle and who holds it.                          |
| `06-household`     | Household: who did the care in the last 30 days, who holds what now, and the four jobs nobody holds.                                                                                                        |
| `07-sitter`        | The page a plant-sitter link opens: what needs doing and in which room, with Done buttons and no account, until the link expires.                                                                           |
| `08-notifications` | Settings, Notifications: the email reminder, weekly digest and household email settings as switches.                                                                                                        |

`npm run mobile:validate` runs in CI (the `Lint` job) and checks every size,
every character limit, native/`package.json` version parity, and secrets
hygiene. It is the gate; this file is the context it cannot encode.

## Plant photos

The iPhone capture gives each of the eight demo plants a photograph of its
species. They are in `frontend/scripts/store-shots/photos/`, and only the
capture reads them: no app build, seed, test or user account includes them.
`setUpDemoHousehold` in `shots.mjs` signs in as the member who added each
plant and adds the photo the way the app does: it asks the API for an
upload URL, uploads the bytes, and confirms. A plant that already has a
photo is skipped.

Every photo is the photographer's own work on Wikimedia Commons, in the
public domain or CC0. The license was read on the Commons file page
itself, and the original file's SHA-1 matched the one Commons publishes.
None shows a person, a brand, a label, a watermark or any text. Each was
cropped to a square, resized to 800 x 800, re-encoded as JPEG and stripped
of metadata. `store-assets/photo-credits.json` records, for each one, the
source page, the original file's URL and SHA-256, the author, the license
with the license text quoted, and how the species was identified. The
capture refuses to upload a file whose SHA-256 doesn't match its record, so
a photo can't change without its credit changing too.

| Plant           | Species                  | Photo                                                                                                                                                  | Author         | License       |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------- |
| Monstera        | _Monstera deliciosa_     | [6542Plants of the Philippines 05](https://commons.wikimedia.org/wiki/File:6542Plants_of_the_Philippines_05.jpg)                                       | Judgefloro     | CC0 1.0       |
| Fiddle Leaf Fig | _Ficus lyrata_           | [Geigenfeige blatt](https://commons.wikimedia.org/wiki/File:Geigenfeige_blatt.jpg)                                                                     | Mantelmoewe    | CC0 1.0       |
| Golden Pothos   | _Epipremnum aureum_      | [Epipremnum aureum](https://commons.wikimedia.org/wiki/File:Epipremnum_aureum.jpg)                                                                     | Sergei         | Public domain |
| Aloe            | _Aloe vera_              | [Potted Aloe vera plant](https://commons.wikimedia.org/wiki/File:Potted_Aloe_vera_plant.jpg)                                                           | Arjun01        | Public domain |
| Snake Plant     | _Dracaena trifasciata_   | [Snake plant … Waoleona Buton Island 02](<https://commons.wikimedia.org/wiki/File:Snake_plant_(Sansevieria_trifasciata)_Waoleona_Buton_Island_02.jpg>) | David E Mead   | CC0 1.0       |
| Peace Lily      | _Spathiphyllum wallisii_ | [Lepelplant 16](https://commons.wikimedia.org/wiki/File:Lepelplant_16.JPG)                                                                             | TUFOWKTM       | Public domain |
| ZZ Plant        | _Zamioculcas zamiifolia_ | [Plants in my Home garden 2026 August 15](https://commons.wikimedia.org/wiki/File:Plants_in_my_Home_garden_2026_August_15.jpg)                         | Rajasekhar1961 | CC0 1.0       |
| Jade Plant      | _Crassula ovata_         | [Crassula Ovata Geldpflanze 32 Jahte alt](https://commons.wikimedia.org/wiki/File:Crassula_Ovata_Geldpflanze_32_Jahte_alt.jpg)                         | NormanSchwarz  | CC0 1.0       |

None of the photos needs a credit. To replace one, use another public-domain
or CC0 photo that passes the same checks, and change its file and its record
together.

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

- **Push is claimed for iPhone only, and only for a build made with it.**
  Native push is on in production for iOS and was verified on an iPhone on
  2026-10-09 with build 4001 (`docs/native-push-setup.md`, step 8), so the
  App Store description says reminders arrive by email and, on iPhone, as
  push notifications once turned on. That is true only of a build made with
  `VITE_NATIVE_PUSH_ENABLED=true`; one made without it shows no push UI, and
  an app that advertises notifications and delivers none is a 2.3.1
  rejection and a bad first review. Android push is off
  (`VITE_NATIVE_PUSH_ANDROID_ENABLED=false`, no FCM credential), browser push
  is hidden when `isNativeApp()`, and SMS is off in production
  (`sms_notifications_enabled = ""`), so the Google Play copy still says
  reminders are email-only.
- **No purchase claims.** The native build hides all billing UI, so the
  listing states the app collects no payment. If in-app purchase is ever
  added, this copy has to change with it.

No ratings, review counts, awards, endorsements, pet-safety claims, or plant
health guarantees appear anywhere in the metadata, and none should be added.

## Known gaps before a submission

The artwork validates, but validating is not the same as selling:

- **The plant photos are stand-ins, and only the iPhone frames have them.**
  Each demo plant shows a real photograph of its species, listed above,
  not a photo the invented household took. The Playwright capture (iPad and
  Google Play) uploads none, so those frames still show the brand
  placeholder. With one photo per plant, `PhotoTimeline` (which needs two)
  never appears.
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
