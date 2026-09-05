# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) once it
reaches 1.0.0 (pre-1.0: minor bumps may include breaking changes — see
`docs/RESPONSIBLE-TECH-AUDITS.md` for the REL-05 pre-1.0 policy statement).

> **Note on history:** this file was introduced 2026-07-05 with the
> `v0.13.1` release. Entries for `v0.2.0`–`v0.12.3` were backfilled on
> 2026-07-16 from `git log`, dated by tag date — best-effort summaries of
> each release's main changes, not exhaustive commit lists (see
> `git log <prev>..<tag>` for those). Every release from `v0.13.1` forward
> gets a dated entry as part of the release PR.

## [Unreleased]

### Added

- **A household can now record its timezone.** Nothing uses it yet, and that
  is deliberate. Due dates in this app are stored as exact moments and
  compared in the server's own zone, which is why a plant added in the evening
  could already be overdue and why the weekly digest and the app could
  disagree about how late a task was. Teaching the app that watering happens
  on a _day_, in _your_ day, changes how every task already in the app is
  counted — so this release stores the setting and plans the change
  (`docs/adr/0025-household-timezone-and-the-due-date-migration.md`) rather
  than making it. A household that has not set a zone keeps exactly the
  behaviour it has today.

### Security

- **Mail sent to security@ could add headers to the copy we forwarded.** The
  inbound forwarder moves the original `From` into a `Reply-To` on a message
  re-sent from our own DKIM-aligned domain. It sanitised that value for the
  visible display name but not for the `Reply-To` line, and it removed only the
  message's own line ending — so a sender who put a bare newline inside their
  `From` header had whatever followed it emitted as a header of their choosing.
  A `Bcc` was reachable this way, on a message carrying this project's sending
  reputation. Every carriage return and newline is now collapsed out of the
  value before it reaches either header. Nobody is known to have used this; it
  was found by writing the first tests the function has ever had.

## [0.28.0] - 2026-09-05

### Fixed

- **A slow AI chat turn could bill a household for an answer it never got.**
  Each call to the model is bounded, but a turn makes up to six of them, and six
  bounded calls can still run past the point where the function is killed. A
  killed function skips the cleanup that reconciles the tokens reserved at the
  start of the turn — so the household was charged roughly eight thousand tokens
  of its monthly allowance for a turn that produced nothing, and the
  conversation stayed locked until the claim expired. A turn now has an overall
  time limit as well as a per-call one, and ends in time to give the tokens
  back.

- **Marking a task done never cleared it from the dashboard.** Reported by a
  household: mark a task done, refresh, and it is still sitting there as
  upcoming. It was saving correctly the whole time. The dashboard card listed
  everything due in the next seven days, and completing a task moves it forward
  by its own interval — so a weekly task, the most common watering interval
  there is, landed straight back inside the window and could never leave. The
  `0.27.0` note below said this was fixed; it stopped the row flickering and
  left the reported behaviour untouched. The card now lists only what can be
  done now — overdue and due today — under the heading "To do now". Tasks due
  later in the week are still shown, as a count rather than as work you are
  being asked to do.

- **The public API rejected every request, from the day it shipped.** API-key
  authentication resolved a presented key by querying a `GSI3` index that the
  table Terraform has never defined — `infrastructure/modules/database/main.tf`
  declares `GSI1` and `GSI2` and nothing else creates a third, which the live
  production table confirms. DynamoDB answers a Query naming a missing index
  with `ValidationException` rather than an empty result, so no `/api/v1/*`
  request could authenticate in any environment. Key rows are now written to
  and read from `GSI1` under the `APIKEY_HASH#` partition prefix, the same
  pattern `calendarTokens.ts` already uses, so the fix needs no table change.
  Two new checks in the backend suite fail the build if any source file ever
  again queries an index — or writes a GSI key attribute — the committed
  Terraform does not declare. **Any API key minted before this change must be
  re-created under Settings → API keys:** its row carries the old attribute
  names. Nothing is lost, because no key issued to date has ever worked.

- **A plant added five minutes ago was already overdue.** Every task created in
  the app was due at the instant it was created, so a second later the sitter
  view showed a red "overdue" badge, `?overdue=true` counted it, and the weekly
  digest mailed it as a plant at risk — while the task list next to it said
  "Today". A household's first reminder could scold them for neglecting a plant
  they had just finished setting up. New tasks are now due at the end of the day
  they were created, in the creator's own timezone, so all four surfaces agree.

- **A placement check that could not be run looked like a placement that
  passed.** The plant page's placement card warns when a species that may be
  toxic sits in a room marked as reachable by pets. For any species outside the
  small curated table, one species read supplied that check — and when the read
  failed, the check vanished along with the whole card, which is exactly what a
  household sees when the spot is fine. The card now says the placement has not
  been checked instead of disappearing.

- **Removing someone's access could leave some of it behind.** Every listing of
  revocable credentials — sitter links, caretaker seats, plant tags, kiosk
  sessions — read only the first page and stopped. Revoking searched that short
  list, so a household with enough history could remove a departed member and
  have their oldest link quietly stay live, with the confirmation reporting a
  count that was too low to notice. Every listing now reads to the end.

- **A paying subscriber could be told they were on the free plan.** If the
  billing read failed, the account page stated "Your household is on the
  Seedling plan" as fact, offered to switch them to a plan they already had, and
  named the wrong tier in the cancellation notice. It now says what it could not
  load.

- **Paid limits no longer outlive the payment.** Four gates decided what a
  household could do by reading the plan on file rather than what it is
  currently entitled to. A household mid-way through a failed-card retry could
  still mint API keys its own next request would refuse, was shown an allowance
  nothing enforced, and kept spending a paid image-analysis budget for the whole
  retry window. The same change fixes the opposite error: a lifetime purchase is
  now a floor, so a later cancellation cannot erase it.

- **The nightly household job could stop partway through and report success.**
  It is now bounded, time-boxed, and resumes where it left off.

- **A release could break tabs that were already open.** Deploying deleted the
  previous release's files immediately, so anyone mid-signup with a
  confirmation link open got "We couldn't load this page" on their next tap.
  Superseded files now stay for seven days.

- **The help page said our emails had no unsubscribe link. They have had one
  since August.** Someone asking "how do I stop the emails?" was told, in the
  one place they went to find out, that there was no way to — while the weekly
  digest and the annual recap both carried an unsubscribe footer link and the
  one-click button mail clients show. The answer now leads with the two ways
  out that need no sign-in, keeps the settings toggles as the finer control,
  and names the one message that genuinely has no unsubscribe: a task reminder,
  which answers a task the recipient created for themselves.

- **A sitter's plant photos outlived the sitter's access.** A brief handed out
  permanent, unauthenticated image links, so revoking the brief left every
  photo in it reachable by anyone who still had a URL. Photos are now signed
  per request and expire with the link they came from.

- **Sitter and kiosk tokens were stored in plaintext.** Anyone who could read
  the table could use them. They are now hashed at rest, the way API-key and
  calendar tokens already were. Links already in circulation keep working.

### Changed

- **The weekly digest decides who wants it before building it.** It used to
  assemble the full per-household report and only then check whether anyone
  had asked for one.

- **Spanish is no longer downloaded by every visitor.** The catalog was
  shipped on the critical path to everyone, in a language the app gives no way
  to select. It now loads on demand: **20,039 fewer bytes** on every first
  visit. Whether Spanish becomes reachable at all remains an open decision.

- **AI chat re-sent its static prompt prefix on every model call**, up to six
  times per turn. The prefix is now cached, and cached tokens are still counted
  against a household's monthly allowance — the discount belongs on the bill,
  not on the meter.

- **The stack can now see a total outage.** A health check probes a real
  application route every 30 seconds and requires the app's own markup in the
  response, so a 403 served by a healthy CDN is caught in about three minutes
  instead of by a person. When the check itself stops reporting, that alarms
  too. Adds roughly $2.60/month.

- **A fresh worktree can no longer push without running the quality gate.**
  The hooks lived in a directory `npm install` generates and git silently
  skipped them where it was missing — the push succeeded, ungated, with no
  output. Hooks are now tracked in the repository.

- Store-release checks that need no signing material now run on every pull
  request, the secret scanner reads files on disk rather than only commit
  patches, the end-to-end tests are typechecked and linted, and the tooling
  scripts are linted at all. Several of these gates could not previously fail.

## [0.27.0] - 2026-09-05

### Added

- **Caretaker seats.** A dog walker, a cleaner, a neighbour who waters on
  Thursdays — someone who tends the plants without joining the household. Each
  gets their own token-scoped link, their work is attributed to them by name in
  the activity feed, and a photo can stand as proof of visit.

- **Coverage — who could actually keep this house alive.** Not a leaderboard.
  It shows which plants depend on exactly one person, so a household can see
  its own bus factor before someone goes away. A household that could not be
  checked says so rather than reporting confident zeros.

### Fixed

- **Five ways the paid path could take money without delivering.** Cancelling
  and resubscribing granted another free trial, every time, forever. A
  household that stopped paying kept full paid limits for the whole of Stripe's
  dunning cycle. A declined first invoice still bought paid limits. Prices are
  now reconciled against the catalogue before a checkout is created, so a
  transposed price id cannot silently charge an amount nobody was shown. A
  lifetime purchase is treated as a floor that a cancellation cannot fall
  below.

- **Marking a task done looked like it had failed.** Completing a task on the
  dashboard removed the row, then the next refresh put it straight back —
  because a task due again within the week genuinely is still upcoming. It had
  always saved. The row now moves to its new date instead of vanishing.

- **A new member was skipped past the guided first run**, because the app could
  not tell "this household has already started" from "this person is new to
  it". And a household whose first plant was a Monstera, ZZ plant, Calathea or
  Hoya finished onboarding with no schedule at all.

- **A departed member kept working credentials.** Removing someone from a
  household left their API key, plant tags, sitter links and kiosk links live.

- **The frost warning quietly dropped plants it could not check**, and removed
  its own "we couldn't check everything" caveat in the same breath.

- **Leaf health returned a canned demo answer at HTTP 200** when the AI service
  refused the request, instead of saying it could not check.

- **Inbound mail was relayed on an unproven scan verdict**, and personal data
  was reaching the logs.

- **Sign-in and every other page painted late**, because the font that decides
  the largest paint was not discovered until the stylesheet referencing it had
  been fetched and parsed.

- **Accessibility, across eight surfaces.** Destructive dialogs never spoke
  their consequences and opened with focus on the destructive button. A fake
  tab strip promised arrow-key navigation it did not implement. Alerts
  interrupted screen readers for content that had merely finished loading, and
  four pages nested a live region inside another one. Filtered lists changed
  silently.

- **Emails ignored the language you chose**, because the setting was read from
  a field that never existed, and the chat safety notices were English-only for
  everyone.

### Changed

- **Monitoring can now see failures it previously could not.** An entire
  scheduled run failing looked identical to a quiet week: the alarm needed more
  errors than the retry policy could ever produce. Bounce and complaint rates
  are now watched too, sustained across hours so one bad address cannot page
  anyone.

- **An outage is detected by something that loads a page.** The uptime check
  asked the API whether it was healthy and never looked at the site — so a
  frontend serving errors on every route read as green.

- **Continuous integration is roughly a quarter of the time it was**, without
  removing a single check, and the local gate no longer cancels the run that
  tests what actually landed on the main branch.

### Fixed

- **Removing someone from a household now revokes what they issued, not just
  their session.** Their API keys kept working (the key row records that its
  creator _was_ a member, never that they still are), and so did every plant
  tag, sitter link and kiosk link they had created — plant tags and kiosk links
  have no expiry at all. API keys now re-check the creator's membership on
  every use, the same rule sessions and calendar feeds already follow; the rest
  are revoked as part of the removal, before the anonymisation sweep that would
  otherwise make them unattributable. The confirmation dialog says so before
  you remove someone, and the audit entry records what it cost.
- **The plant-tag management list is rate-limited and audited.** It hands back
  every active tag's raw, never-expiring token in one call — the only bulk read
  of live secrets in the API — and was the one route in its file with neither a
  limit nor an audit event.

### Fixed

- **The inbound-mail forwarder no longer relays a message whose scan never
  finished.** It refused only an explicit `FAIL`, so three states reached the
  maintainer's inbox untouched: `GRAY` (scanned, inconclusive),
  `PROCESSING_FAILED` (the scan did not complete — what SES reports under load
  or on a message too large to scan), and no verdict at all. Since the
  forwarder re-sends from the project's DKIM-aligned domain, anything it let
  through arrived with that reputation applied, on the addresses `security@`
  and `abuse@`. It now relays only on an explicit `PASS` from both scans, logs
  the three refusals distinctly with the S3 key the raw message is kept at, and
  raises a CloudWatch alarm when a message is refused for an unverified scan so
  a wrongly-refused report is not lost in a log group.

- **Move Day's frost warning no longer shrinks when a lookup fails.** A plant
  whose saved species record could not be read was dropped from the
  frost-tender list exactly as though it had been checked and found hardy —
  and because the whole amber block was hidden when that list came back empty,
  the "these aren't cleared, just unchecked" caveat disappeared along with the
  plants it described. The check now counts what it could not read, the count
  is stored with the list so the fortnight the card stays up keeps carrying it,
  and the card says how many plants it could not check.

- **Server-side logs are redacted, and the dry-run branch no longer logs a
  recipient's address.** The pino logger had no `redact` config at all, so the
  only thing standing between a `logger.info({ ...body })` and a 30-day
  CloudWatch retention was whoever wrote that line. It now censors `email`,
  `to`, `phone`, `password`, `pin`, the token family, `apiKey`, `imageBase64`
  and `authorization`. The email dry-run branch — which fires on the whole
  notification path wherever `SES_FROM_EMAIL` is unset — now logs the
  recipient's domain instead of the address. `actorEmail` stays, deliberately:
  the audit trail's value is naming the actor, and the consequence (the log
  groups are an in-scope PII store, bounded by their 30-day retention) is now
  written down in `docs/compliance.md` and `docs/observability.md` rather than
  left implicit.

### Fixed

- **A leaf-health check can no longer answer with a fixture when the model is
  unreachable.** The canned demo assessment was returned on any Bedrock access
  error, at HTTP 200 — so a Terraform apply or model-access change that removed
  `bedrock:InvokeModel` would have turned every check in production into the
  same canned "monitor" result, with no 5xx, no error metric, and one WARN line
  nothing reads. The fallback is now declared by the environment
  (`leaf_health_demo`, default off) rather than inferred from the error: a
  deployment that is supposed to reach Bedrock answers 503 and logs at ERROR,
  which the existing api-5xx alarm already watches. Nothing was analysed, so
  the month's allowance is returned rather than spent.

## [0.26.0] - 2026-09-04

> `0.25.0` was tagged and, like `0.24.0` before it, never reached production.
> Its deploy applied the new CloudFront routing and then stopped before the
> frontend shipped, which took the site down until the routing was given
> something to point at. Both defects behind that are fixed below. Everything
> in the `0.24.0` and `0.25.0` entries ships here, for the first time.

### Added

- **Ask family to do it.** A task you cannot get to can be handed back to the
  household instead of quietly going stale: it becomes claimable by anyone and
  the rest of the house is told once, with an optional note. It reuses the same
  "up for grabs" state auto-handoff already reaches, so a task asked about and
  a task escalated behave identically from then on. Free on every plan, once
  per task per person per day, and never sent to whoever just asked, anyone
  who is away, or anyone inside quiet hours.

### Fixed

- **The site went down mid-deploy, and the deploy could not finish.** Two
  separate defects, one behind the other:

  The production deploy role could create every resource the stack needs
  except a KMS key — `kms` was missing from its permission list entirely. The
  SES event key added in `0.24.0` was the first one the stack ever asked for,
  so nothing had exercised the gap before.

  Past that, the deploy stopped again on its own safety mechanism: it refuses
  to ship unless it can snapshot a rollback copy of every function, and a
  function created minutes earlier by that same run has no previous version to
  copy. That would have blocked the first deploy of every new function
  indefinitely. A brand-new function is now allowed to have no snapshot — but
  only after confirming it really exists, so a function that failed to be
  created is still a hard stop.

  Because the frontend upload runs after the backend, neither shipped, and the
  new routing was left pointing at files the previous release had never
  uploaded. Every page but the home page returned an error until the deploy
  completed.

### Security

- **CI stops leaving credentials on disk.** Checkout steps across every
  workflow no longer persist the git token into the runner's config once they
  are done with it, and the deploy workflows no longer interpolate values
  directly into shell commands — they pass through environment variables,
  where a value cannot be read as script. The static-analysis image is pinned
  by digest, and the committed Gradle wrapper is checked against Gradle's own
  published checksums on every run.

- **Dependency updates**, including `brace-expansion` and `tar` past
  denial-of-service advisories, plus Stripe, i18next, Middy and Capacitor.
  Every dependency ecosystem now waits a cooling-off period before proposing
  an update, so a compromised release is less likely to be picked up
  automatically on its first day.

## [0.25.0] - 2026-09-04

> `0.24.0` was tagged but never reached production: its deploy failed on two
> infrastructure defects (fixed below) and the release was rolled back. Its
> entry stands as the record of what that tag contained; everything in it
> ships here, for the first time, together with the entries below.

### Added

- **Seasonal Move Day.** When tonight's already-cached forecast crosses the
  frost line or today's crosses the heat line, every plant sitting somewhere
  other than its home for the arriving season becomes a task — split
  round-robin across the members who are actually around, so the move is not
  one person's afternoon. Last year's move is re-armed rather than duplicated,
  and any member can take over someone else's move.

- **Auto-handoff.** A task nobody has done by a number of days you choose goes
  up for grabs on its own, and the rest of the household is told once. The
  person who always notices no longer has to be the one who asks. Off by
  default, with a floor of five days, at most one handoff per occurrence, one
  roll-up per person per run, and never to whoever just dropped it or anyone
  who is away or inside quiet hours.

- **Care rotation.** A space can take turns instead of always falling to the
  same person. Free on every plan — rotation is how a household shares work,
  not a feature to sell.

- **Identification top-up packs.** Twenty extra plant identifications for
  $1.99 when a household runs out, instead of pushing them to a bigger plan
  they do not need. Credits last a year. The pack stays unsold until the price
  is configured, and an unreadable credit balance reads as unknown, never as
  zero.

### Changed

- **The plans are cut on homes and hands, not collection size.** What a
  household pays for is now how many homes it spans and how many people share
  the work, rather than how far its collection has grown.

  So the plant caps moved both ways: Seedling doubles from 10 to 20, and
  Garden comes down from 500 to 200 — a number no household of that size was
  near, and no longer the thing being sold. In exchange, **Garden and
  Greenhouse now take unlimited members**, where they were capped at 6 and 50.
  The free tier covers three people instead of six, because the fourth pair of
  hands is the point at which a household is really coordinating.

  **Belonging to more than one household is now a Greenhouse capability** —
  Seedling and Garden each cover one home. Care rotation stays free on every
  plan; sharing the work is not something to sell.

  Nothing is taken away from anyone: a household already past a new limit
  keeps everything it has, and the cap only refuses the next addition.

### Fixed

- **The production deploy itself.** Two defects introduced with the email
  deliverability work made `terraform plan` fail outright and left SES unable
  to use its own topic key. Both were invisible to every gate that ran on the
  PR that introduced them.

- **A new household's first seconds.** The app refreshed its login token just
  after recording the new household rather than just before, so the first
  request went out on a token that predated the household and came back 403.
  It recovered on its own, but a failed plants read is read as "this household
  has already started" — so a brand-new home could be skipped past the guided
  first run entirely.

- **The release safety net could not see the release.** The post-deploy smoke
  test still expected the pre-activation route and would have failed on a
  correct deploy — and a failed smoke rolls the release back automatically.

## [0.24.0] - 2026-09-04

### Added

- **One list of what is due today and what is overdue, across every household
  you belong to** — grouped by home with the household name on every row,
  never merged into one flat list. A household whose read fails comes back as
  an explicit unavailable entry rather than an empty task list, because a
  missing group reads as "nothing due there". Greenhouse-gated per user across
  every membership, so switching to a free home does not lock the page; it
  answers 402 when no household grants it and 503 when entitlement could not
  be read, because "we couldn't check" is not "you don't have it". Acting on a
  row still goes through the ordinary single-household routes — nothing gains
  the ability to write across households.
  [ADR 0017](docs/adr/0017-cross-home-today-is-a-work-queue-not-a-global-view.md).
- **Email stopped being a notification and became something worth opening.**
  Every message the app sent was plain text, in English, with no link to the
  thing it was about and no way to unsubscribe — and the unsubscribe was not
  merely missing but unreachable, because SES v1's `SendEmailCommand` has no
  field to put a header in. Mail is now multipart HTML with a real plain-text
  twin rendered from the same block list, in English or Spanish, with every
  plant, task and setting a message names linked directly to its own page, and
  RFC 8058 one-click unsubscribe on everything that is not transactional.
  Language comes from a new **Email language** setting whose unset value means
  "never chosen" rather than "English", and which Settings back-fills from the
  language you are already reading the app in — so it is right before anyone
  presses Save. The January year-in-review gets its own switch instead of
  riding the master email toggle, which is why turning off the weekly digest
  never used to stop it.
  [ADR 0021](docs/adr/0021-email-rendering-and-usefulness.md).
- **The daily reminder now says what needs doing, not how much.** It was two
  integers and a link to a filtered list, while the full task list sat in
  scope on the line above. It now names every due task by plant and care type
  with how overdue it is, links each row to that plant, and puts unclaimed
  work in its own "up for grabs — nobody has claimed these" section instead of
  folding it into an anonymous number mailed identically to everybody. If you
  are covering for someone who is away, the email tells you who and until
  when. When the household's forecast is readable it adds a line about rain or
  frost; when it is not, it adds nothing rather than implying clear skies. SMS
  and push keep the short counts sentence; only email gets the list.
- **The weekly digest now says who last did each job.** It listed plant names
  and days overdue, mailed identically to every member, linking nowhere, while
  the backend already knew everything it did not say. It now leads with
  unclaimed work — the work nobody has taken — names who last did each job and
  when (and says "you" when that is the reader), shows the household's
  seven-versus-seven-day trend, carries the plant's latest photo, warns when a
  plant the verified table lists as toxic sits in a pet-accessible space, and
  adds a weather note read from the cached forecast only, at no upstream cost.
  A genuinely quiet week now sends nothing instead of a cheerful empty digest,
  and a week where the at-risk query _failed_ still sends and says out loud
  that it could not check.
- **Invitations can be emailed.** The app has minted 128-bit, seven-day invite
  codes since May 2026 and had no way to send one, so every invitation was a
  copy-and-paste and the funnel from "invite created" to "invite accepted" had
  no email step in it at all. An admin can now type an address on the
  Household page and press send — admin-only, ten per household per day and
  one per address per day, with no free-text field. Four more household emails
  follow the same thread: every existing member hears that someone joined,
  with an extra line for whoever minted the invite; a weekly note names
  unclaimed work due in the next few days, in the window the daily reminder
  does not cover, so a hand can be asked for _before_ anything is late;
  whoever is named as cover for an away member gets the list and the dates;
  and the person whose task somebody else did gets a quiet "someone covered
  for you" — no counts, no ranking, and no mention of anyone who did less.
  Each of the four has its own switch.
- **Billing emails exist.** Paid plans have been live since 0.23.3 and the
  product sent nothing about money: you could be charged, have your card
  decline, lose your subscription and delete your account without hearing from
  the app once. Six emails close that — a receipt, a renewal notice before a
  trial converts to a charge, a payment-failure notice linking Stripe's own
  hosted invoice page, a card-expiring warning, a cancellation confirmation,
  and an account-deletion confirmation that states in the same breath and at
  the same weight what was deleted and what was _kept_ (shared care history
  under a pseudonym, Stripe's record of payments already made, backups inside
  their retention window). All six are transactional: they ignore the
  notification preferences and the do-not-disturb window, carry no
  unsubscribe, and say in the footer why there is none. They go to the
  household's admins, taken from our own member roster rather than from the
  address Stripe holds, so a billing email never reaches anyone the household
  has not put on its own member list, and they dedupe on the existing Stripe
  event ledger so a redelivered webhook cannot send a second receipt.
  [ADR 0023](docs/adr/0023-billing-lifecycle-emails.md).
- **A dead address stops being mailed.** There was no bounce feedback anywhere
  in the stack, so nothing ever learned that a mailbox had gone away: a
  hard-bouncing address was re-mailed every week forever, spending the sending
  reputation that every message from the domain shares — password resets
  included. SES bounce, complaint and delivery events now reach a new handler.
  A hard bounce or a spam complaint suppresses the address permanently; a soft
  bounce counts against a budget of five in thirty days, and a successful
  delivery clears the counter. Suppression is visible rather than mysterious:
  your notification settings say email is paused and why, with a **Resume
  email to this address** button you press yourself, and your housemates see a
  neutral "Email not arriving" marker beside your name — no address, and no
  hint whether it was a bounce or a complaint. Outbound mail also
  authenticates twice now: a custom `mail.` MAIL FROM subdomain makes SPF
  align under DMARC alongside DKIM, so one broken mechanism is no longer a
  total loss. Forgot-password and admin-invite mail is written in the app's
  own voice instead of AWS's stock copy — the one message a locked-out user
  has to trust — and replies to app email now reach the monitored `support@`
  mailbox. A suppression has no automatic expiry by design, so someone who
  fixes their mailbox stays suppressed until they press Resume.
  [ADR 0022](docs/adr/0022-email-deliverability-and-bounce-handling.md).
- **The Away Kit.** A sitter link set for three weeks showed its sitter one
  week, silently: both task views looked a fixed seven days ahead regardless
  of the window the household had agreed. The lookahead is now the link's own
  end date. Any member can mint a link now, not only an admin — the traveller
  is rarely the admin — balanced by revocation an admin can exercise over any
  link and a member over their own, with the activity feed naming who opened a
  door, with what label, and for how long, never the token. Sitters get a
  printable handoff brief at their own link: the household plant by plant with
  its space and placement, the household's _own_ care words, the verified
  pet-safety entry, the latest photo, and the tasks due inside the window,
  with print styles that drop the site chrome and keep one plant to a page so
  it can be left on a counter. Creating a link first counts what the brief
  will be missing — "6 plants have no watering note — your sitter will be
  guessing" — and links straight to each plant, while somebody still cares
  enough to write one. Sitters can send photos home through the same link
  (sixty per link, 300 kB each, image type read from the file's own bytes,
  refused once the window ends), and members get an **away recap** replaying
  what the sitter did inside it. The window fix and member link-creation ship
  free at every tier, because a task view that contradicts the window the
  household set is a defect and not a feature; the brief, photo-back and recap
  are one Garden entitlement, and a household without it gets the same generic
  404 a bad token gets, so a sitter is never told the household's tier.
  Seedling keeps one live link of up to seven days — a weekend away, complete
  and free; Garden lifts that to ninety days and ten live links, Greenhouse to
  twenty-five. [ADR 0015](docs/adr/0015-the-away-kit.md).
- **Plant Tags: a printed QR label anyone in the house can use.** The person
  who was never going to install the app can now scan the label on a pot and
  see when that plant was last watered and by whom, read the household's own
  care notes, and press one button to say they have just done it — no account,
  no app, typing only a display name, recorded into the shared history with
  its own attribution. Print the sheet from the app; QR codes are encoded in
  your own browser, so no token is ever sent to an image service. A tag is
  scoped to exactly one plant and two actions, can be revoked and re-issued
  one at a time, and the household can turn on an optional scan PIN with a
  per-tag lockout that does not invalidate anything already printed. Members
  also get "last watered by" on the plant's own page, which the care history
  always knew and nothing showed. Garden allows fifty active tags, Greenhouse
  unlimited. [ADR 0016](docs/adr/0016-plant-tags-account-free-care-actions.md).
- **A kiosk wall display.** A spare tablet in the kitchen or a screen in an
  office breakroom becomes a read-mostly view of what needs doing today, with
  tap-to-complete and no login. The link deliberately does not expire — a wall
  display that dies on a timer is a broken wall display — so revocation is the
  control instead, and issuing a new link revokes the old one in the same
  click, which is the answer to "someone photographed the screen". It can read
  today's tasks and complete one, and nothing else. Because this is the one
  feature whose cost scales with wall-clock time rather than use, each refresh
  interval is priced on the control that sets it. Greenhouse; revoking is
  deliberately not gated, so a household that downgrades can always turn its
  screen off.
- **Double-care detection and schedule drift**, two signals only a shared
  household can produce, both computed from the completion log the app already
  writes. If a housemate already logged that care inside the care type's own
  window — a day for watering, longer for slower care — marking it done stops
  and says who did it and when, and asks whether to log it anyway. Nothing is
  written until you answer: never silently dropped, never silently
  double-logged, and a confirmed duplicate is tagged against the completion it
  duplicates and counted on the analytics page. Separately, when a task's real
  median interval has drifted more than 30% from its schedule across at least
  four completions, the plant page offers to match the schedule to what
  actually happens, in one tap. Below four completions it says why it cannot
  tell rather than reporting a drift of zero. Garden and above.
- **A house rule on each plant**, up to 140 characters, editable by any
  member, shown as a confirmation the moment somebody marks that plant's task
  done — "bottom-water only, and let it drain" reaches the person about to
  water it instead of living in one person's head. It travels into the sitter
  brief too. No rule, nothing shown. Free at every tier.
- **Members can see the paid features they are locked out of, and ask for
  them.** Billing is admin-only, so a member who hit a paid feature previously
  saw nothing at all. Locked features now render visible and explained, name
  the plan that includes them and its price, and offer a one-tap ask that
  names the household's admins and reaches every one of them by push, email
  and an activity-feed row naming the specific feature — once per member per
  feature per week, with the UI saying when you can ask again. Each paid plan card
  also divides its price by the household's active member count, in whole
  cents so no cent is lost, showing the uneven split honestly when it does not
  divide, with a share action. It is hidden for households of one and whenever
  the member count cannot be read. Checkout and the billing portal stay
  admin-only.
- **The first run is reachable, and it does something.** Nothing in the app
  ever navigated to `/welcome`: both ways into a household finished at the
  dashboard, so a brand-new user's first authenticated screen was an empty one
  and the three-screen tour was dead code you could only reach by typing the
  URL. The first run now happens, and instead of three screens of prose it
  adds your first plant — with a curated care schedule when the species
  matches one, and no invented schedule when it does not — and mints a real
  invite link, because sharing care with somebody is the whole point and a new
  user never used to meet it in their first minute. Both steps are genuinely
  skippable, and an established household signing in on a new device is not
  sent through it again.
- **Help is public and true.** "How do I cancel", "what can a plant sitter
  see" and "why didn't my reminder arrive" sat behind the login, out of reach
  of the two people most likely to need them — somebody deciding whether to
  sign up, and somebody locked out of their account — and unindexable by
  search. The support page even told readers to sign in to read it. Help and
  its nine topics are now public and searchable, each question with a stable
  anchor a support reply can link to. The answers were rewritten from the code
  rather than edited, because several were simply false: they described a
  theme picker for a dark mode that was never shipped, and the whole billing
  section said paid plans were paused, which stopped being true on 2026-09-01.
  Two answers exist because the honest version prevents a support ticket —
  deleting your account does _not_ cancel your subscription, so cancel first;
  and quiet hours run in a timezone that defaults to UTC until you press Save,
  which is why they look broken. The limitations are stated rather than
  glossed.
- **The legal pages are ready to serve in Spanish.** Privacy, Terms, Support
  and the account-deletion page were hardcoded English in an app that is
  otherwise fully bilingual — English Terms on exactly the pages where
  language access carries legal weight. All 101 strings per page now live in
  both catalogs, with sentences kept whole for translators and contact
  addresses interpolated from constants so no locale can name a wrong inbox.
  The Spanish is a careful draft rather than reviewed legal text and says so:
  every non-English render carries a draft notice and a line stating that the
  English version governs, until a native speaker and counsel sign off. It
  ships behind the same non-English-locale flag as the rest of the Spanish UI,
  which is unset in production, so this is groundwork a production reader does
  not see yet.
- **Fourteen more species care guides**, taking the public care library from
  ten to twenty-four, each with its toxicity verdict read off that plant's own
  ASPCA entry. Four plants people ask about — croton, string of pearls, pilea
  peperomioides and air plant — were deliberately left out because the ASPCA
  database has no entry for them, and guessing a pet-safety line is the one
  failure these pages cannot have.
- **The public pages are served as real HTML.** Every public URL returned a
  byte-identical JavaScript shell whose entire readable content was the shared
  title and "Family Greenhouse needs JavaScript to run", while the sitemap
  advertised twenty-five URLs no search engine could read. The marketing,
  care, blog, help, pricing and legal routes are now prerendered at build time
  with per-route title, description, canonical and Open Graph tags, so a
  search result or a link pasted into a chat shows the actual page.
  Authenticated routes still boot from a pristine app shell.
  [ADR 0013](docs/adr/0013-build-time-prerendering-of-public-routes.md).
- **The monthly chat allowance is configurable per tier** rather than one flat
  number for every plan, in the same shape as the other AI caps. No paying
  household's allowance changes: chat is a Garden-and-up feature, and the free
  tier's new production value sits under a gate that already refuses the turn,
  so it is a floor rather than a live spend.

### Changed

- The legal prose no longer loads on startup. Moving 101 keys per locale into
  a catalog the four legal routes fetch on demand takes about 10 kB brotli off
  every single visit, in both languages, including builds where Spanish is
  switched off. No copy moved and no key changed; the legal pages still render
  in full with no flash of raw keys, including when prerendered.
- React and React DOM move to 19.2.8 together, along with the root overrides
  that would otherwise have pinned the pair back.
- Two release gates stopped being hand-maintained numbers. The handler-route
  count and the test-file count were written into `docs/quality-audit.md` and
  `docs/testing.md` and checked there, so every pull request that added a route
  or a test rewrote the same lines and re-conflicted with every other one — on
  2026-09-03 that alone made nine open pull requests unmergeable. Both are now
  derived on demand, and a re-introduced hard-coded count is refused so the
  conflict surface cannot come back. The combined-JavaScript budget was
  likewise sized once for this whole wave of features rather than fifteen
  times; it is deliberately loose and is to be re-tightened against a real
  measurement now that the wave has landed.

### Fixed

- **The calendar feed works from a calendar app now.** Settings handed out
  `${API}/me/calendar.ics`, a route behind the API Gateway Cognito JWT
  authorizer; Apple Calendar, Google Calendar, and Outlook fetch subscription
  URLs with no session, so every subscriber was refused with 401 before the
  Lambda ran. The feed is now a per-user, per-household capability URL
  (`/calendar/{token}/family-greenhouse.ics`): a 256-bit token minted from
  Settings, stored as a scrypt hash (the same construction as API keys),
  shown once, revocable, and regenerable. **The tradeoff is real and stated in
  the UI:** anyone holding the link can read that household's task titles,
  cadence, and due dates. To bound that, the feed no longer emits task notes
  or the assignee's name, membership is re-checked on every fetch, the public
  route is IP-rate-limited, the token is not an API key (it opens nothing
  under `/api/v1`), and the request log never records the path secret (this
  also covers sitter links). `GET /me/calendar.ics` remains as an
  authenticated one-shot download.
- **Sentry now honours Do Not Track, and a crash report is now only what the
  privacy page says it is.** The first-party telemetry rail has always checked
  `navigator.doNotTrack`; `frontend/src/sentry.ts` did not, so the moment a
  `VITE_SENTRY_DSN` was set the "DNT suppresses analytics" sentence would have
  become false without any code change. Sentry initialisation is now gated on
  the rail's own `telemetryAllowed()` predicate so the two cannot drift. The
  same change closes what a report would have carried beyond the stack trace:
  the SDK attaches `location.href` and the referrer to every event and puts
  full URLs in fetch and navigation breadcrumbs, and `/sit/<bearer token>` and
  `/join/<invite code>` are real routes here. URLs are now reduced to the
  rail's normalized route, error messages pass through the rail's sanitizer,
  console breadcrumbs are dropped, every `dataCollection` category that could
  carry a person or their content (user info, cookies, headers, bodies, query
  strings, local variables) is off by declaration on both the app and the API,
  and both session-replay rates are pinned to 0 so adding the replay
  integration later cannot quietly start recording. Nothing is collected
  today — no DSN is configured — and nothing new is collected by this change.
- **A failed read no longer arrives as a fact.** This repo's named defect
  class ([ADR 0010](docs/adr/0010-settled-read-states.md)) was enforced by hand
  on the backend, which is how one budget read got fixed while the
  identically-shaped one in the next file kept answering `0` to a query that
  had failed. `npm run reads:check` now scans the backend too, on the same
  two-directional ratchet, and its first run found twelve occurrences. The
  ones people would have felt, fixed here and across the email work:
  - a household's pest check was skipped for the rest of the day whenever the
    key store was briefly unreadable, because "we couldn't check" was reported
    as "nobody configured this", which the checker treats as permanent;
  - the upstream budget check failed _open_ with a response byte-for-byte
    identical to a fresh day under budget, so an outage looked like a quiet
    day;
  - the annual recap announced "A former plant" — that a plant was gone —
    when the lookup had failed, and printed a raw account id under "Who did
    the work";
  - reminders said "waiting NaN days", printed the literal word "custom" as a
    task's name, printed "0 coming up soon" as though it were information,
    named a member nobody could load "a housemate", and turned an unread
    forecast into "no rain expected";
  - the household roster stopped paging at the plan cap, so members past it
    were silently not considered for a reminder at all;
  - the API-keys list rendered a failed read as an empty list, which reads as
    "you have no keys" to the one person who most needs to know that an old
    key is still live.
- **Everywhere else, an absence is rendered as an absence.** Across the
  features this release adds, the answer to a read that did not settle is a
  named unknown the copy renders as a sentence rather than a value: a scanned
  plant tag says "couldn't load care history" instead of "never watered"; the
  kiosk keeps its last good list behind a stale marker and, on a hard failure,
  says out loud that it is not claiming everything is done; the sitter brief
  shows no pet-safety verdict rather than an unearned all-clear; the
  sitter-link form renders an unreadable plan as unknown, never as free and
  never as unlimited; the away recap distinguishes "we couldn't load it" from
  "nothing was recorded"; the chat endpoint returns an error rather than a cap
  it could not resolve; the bill-split line hides itself rather than divide by
  a member count it does not have; and no billing email states an amount or a
  date it could not read.
- **The legal pages, the help content and the billing documentation described
  a product that takes no money**, days after it started taking money. Privacy
  and Terms now describe what actually crosses the boundary — the email
  address and household id sent to Stripe, Google Tag Manager and Sentry (both
  newly disclosed, along with the fact that both are currently off), and the
  push services that receive notification traffic — and drop the
  commercial-hold language. Smaller corrections in the same pass: a phone
  number outlives turning SMS off, account deletion is refused for the lone
  admin of a household that still has members, and the export is a CSV plus a
  fuller JSON that excludes photos and completions. No policy was rewritten
  and no new commitment was made; every correction was checked against shipped
  code.

## [0.23.5] - 2026-09-03

### Added

- The care assistant can now answer "is this plant safe for my cat/dog?" from
  the verified source instead of from memory. A read-only `check_pet_toxicity`
  chat tool exposes the hand-curated, ASPCA-grounded table behind the public
  pet-safety checker through the same unchanged `lookupToxicity` matcher, and
  returns the matcher's honest "not in our checker" result when the plant is
  missing. The grounding guard now recognises a categorical pet-safety claim
  ("safe for cats", "non-toxic", "fine for dogs", and the Spanish forms) as a
  claim, and an unsupported one is `ungrounded` — it blocks, replaced by a
  refusal that points at the checker and the ASPCA poison-control line —
  rather than `unverified`-and-delivered, because the failure direction is an
  animal being harmed. Streamed pet-safety turns are held until the completed
  answer passes. [ADR 0011](docs/adr/0011-categorical-pet-safety-claims-block.md).
- The `pet-safety` eval class now covers the routine toxic and non-toxic
  lookup, a plant the checker does not have, and the acute case in English and
  Spanish (19 items), and drives every item through the real tool and table
  with a scripted model; its three recorded coverage gaps are asserted closed
  (1 tool, guard blocks) or held as invariants (0 toxicity chunks in the
  corpus — the table stays the only source). The red-team corpus gains a
  `verdict-integrity` invariant so injected text cannot flip, invent, or
  soften a verdict.
- Eight blog posts, weighted toward the wedge the product owns — several
  people, one set of plants: splitting plant care with a partner, watering
  while on vacation, what to leave for a plant sitter, care instructions for
  non-plant people, and merging collections when moving in together, plus
  three high-intent diagnostic posts (signs of overwatering, why leaves turn
  yellow, and how much light a room gets). They deliberately make no new
  toxicity or pet-safety claims — that ground belongs to the care guides and
  `/pet-safe`, where a wrong claim can get an animal hurt — and the two that
  touch pet safety link to the checker rather than restating a verdict. Where
  a mechanism is genuinely ambiguous the post says so and tells the reader to
  change one variable and wait. The prose lands entirely in the lazy `posts`
  chunk that only `/blog/:slug` pulls, so every critical-path budget is
  untouched; only the all-JS-combined budget moved, 386 → 402 kB against
  389.69 kB measured.
- The Household page now shows how care is actually split. A care-load panel
  gives every member their completed care over the last 30 days and the number
  of tasks they are holding right now, with a pooled row for the plant sitter
  and a row for anyone who has left with assignments still on them. When one
  person is carrying most of it the card says so and points at the up-for-grabs
  pool — never at the people who did less. It reads only the household activity
  feed and the task list, both already member-scoped, so no visibility boundary
  moves; it saves each person keeping a private tally, which is where nagging
  starts. If the activity feed hits its page limit before covering 30 days the
  card says "since <date>" rather than printing a share over a period it never
  saw.
- Sitter links can be scheduled to start on a chosen day. The create form
  gained the start date the API has always accepted and nothing ever sent, so a
  link made a week before a trip no longer goes live immediately and burns a
  week of its own window — length is now counted from the day cover begins. The
  sitter's own page also tells them when their access ends: `GET /sitter/:token`
  has always returned `expiresAt` and the page discarded it, so a neighbour had
  no idea how long they were on the hook or that access stops on its own.
- Nine plants the site publishes a full care guide for now have a row in the
  pet-toxicity table. `/care/<plant>` shipped fourteen new guides while
  `/pet-safe` still answered "we don't have that one in our checker yet" for
  bird-of-paradise, anthurium, chinese-evergreen, english-ivy, money-tree,
  christmas-cactus, parlor-palm, hoya, and nerve-plant. Every verdict — the
  first four toxic, the last five non-toxic — was read off that plant's own
  ASPCA entry page, not inferred from the slug and not taken from the care
  guide's prose.
- Paid conversion and churn are countable for the first time.
  `subscription_paid` fires when Stripe moves a subscription to `active` from a
  non-active status, which it only does once an invoice has actually been paid,
  and carries `from` so a trial conversion (`trialing`) stays separable from a
  recovered payment (`past_due`) — real revenue, but not a new conversion.
  `subscription_deactivated` fires on `customer.subscription.deleted` and
  reports the tier the household lost, read before the delta rewrites `planId`,
  with a bucketed `churnReason` so voluntary churn is countable apart from
  dunning failure. Both emits are gated on the existing `STRIPE_EVENT#<id>`
  dedupe ledger, which is written after the apply, so a crash in between loses
  an event rather than counting revenue twice: these numbers undercount, never
  double-count, and `docs/analytics.md` now states that rather than leaving it
  to be discovered.
- `npm run verify` now runs `figures:check`, `api:check`, `sitemap:check`, and
  `brand:check`. Four committed artifacts were standing in for a computation
  with nothing re-running the computation and comparing.
  `scripts/check-doc-figures.mjs` re-derives its figures from the artifacts
  that own them, importing `findHandlerRoutes` from `check-api-spec.mjs` rather
  than reimplementing the scan, and fails in both directions — a wrong figure
  fails, and so does a document that stops stating the figure, because a check
  satisfied by deleting the sentence is a check that quietly stops checking.
  `build-sitemap.mjs --check` builds the XML in memory and byte-compares,
  writing nothing: `prebuild` regenerated the sitemap before every vite build,
  so CI's Build, Lighthouse, and bundle-size jobs each overwrote the committed
  file on a clean checkout and threw the result away, while search engines read
  the committed bytes. `check-brand-assets.mjs` — which SHA256-binds four
  SVG/PNG pairs and dimension-checks 44 rasters — had no call site anywhere
  outside its own definition. And `check-api-spec.mjs` ran only in `ci.yml`, so
  a contributor's green `npm run verify` said nothing about API-spec drift.
- `docs/PR-TRIAGE.md` records the state of the open pull-request queue as of
  `5655398`, with each finding checked against the repo or the running API
  rather than against the pull requests' own descriptions. It is a dated
  snapshot, not a live view.

- A settled read with no data is now a decision the repo has written down, not
  one re-derived per bug. [ADR 0010](docs/adr/0010-settled-read-states.md)
  states the rule that ten previous pull requests (#319, #320, #326, #327, #328,
  #338, #339, #341, #347, #348 — two of which fixed "six more places" and "five
  more" at a time) were each arriving at separately: a query is in flight,
  settled with data, or settled with none, and the third state must be rendered
  as itself rather than as a `0`, an empty list, or an absent card.
- `npm run reads:check` (`frontend/scripts/check-settled-read-states.mjs`),
  wired into `npm run verify` and CI's required `Lint` job. It is a
  two-directional ratchet over `settled-read-states-baseline.json`: a new
  occurrence of the shape fails, and a baseline entry that no longer matches
  anything also fails, so a fix cannot leave its own permission behind. Four
  occurrences are accepted, each with the reason its absence asserts nothing a
  reader would act on. The gate detects one shape and the ADR says plainly
  which shapes it does not.

- `backend/tests/unit/config/branchRuleset.test.ts`, a lockout guard on the
  committed branch ruleset, running in `npm run verify` and in CI's required
  `Test Backend` check. `lockoutRisk(document)` is a pure function of the
  parsed `.github/rulesets/main.json` and refuses the five shapes that drop the
  owner's break-glass path — empty list, absent key, wrong type, wrong actor,
  and `bypass_mode: "pull_request"` on the right actor — with a positive
  control so it cannot pass by refusing everything. Its loader fails on a
  missing or unparseable file rather than vouching for nothing: the parse is
  what catches a truncated ruleset, because a truncated file still contains the
  literal string `bypass_actors` and a grep would wave it through.

### Changed

- Garden annual, Greenhouse annual, and Garden lifetime are withdrawn from
  sale; both monthly plans remain. At the verified Plant.id cost ($0.0585 per
  identification) the per-household AI-cost ceiling — $3.48 on Garden, $7.58
  on Greenhouse — exceeds what an annual subscription earns per month ($3.33
  and $6.67), and a $149 lifetime purchase is fully consumed after roughly 41
  months. Withdrawal is an availability decision, not a deletion: plans carry
  a `withdrawnIntervals` list, `GET /billing/plans` publishes a withdrawn
  cadence as a `null` price (the signal the pricing grid and Settings already
  render as "not available", so the interval toggle disappears on its own),
  and `POST /billing/checkout` refuses a withdrawn cadence with a 400 at both
  the schema and the service so a stale client or crafted request cannot start
  one. Nothing changes for households already on an annual or lifetime plan:
  the prices and their Stripe ids stay on the catalog so renewals still
  resolve to the right tier, the billing portal keeps managing them, and
  entitlement, which reads `planId` alone, is untouched. No Stripe object was
  archived.
- The free tier's leaf-health allowance drops from 200 checks a month to 20 at
  the next `terraform apply`. Two of the three AI cost caps were tier-blind: a
  $0 Seedling household got the same 200 leaf-health checks as a $9.99
  Greenhouse household, an inference exposure of up to $1.79 per free household
  per month against no revenue. Production now sets
  `leaf_health_monthly_cap_seedling = "20"`, which takes that tier's ceiling
  from $1.18 to $0.12; Garden and Greenhouse are left blank and inherit the
  flat 200, so no paying household's allowance changes, and identification was
  already 3/30/100 by tier. Nothing is revoked retroactively — the cap binds on
  the next reservation, so a household already past 20 in the current period is
  blocked until the month rolls over.
- Every AI cap is settable per environment, with the code defaults unchanged.
  `leaf_health_monthly_cap` and its `_seedling`, `_garden`, and `_greenhouse`
  overrides are declared at the root and wired through to the plants Lambda: a
  blank value means the code default and `"0"` means unlimited for that tier.
  The handler makes no plan lookup at all until a per-tier value exists, so the
  all-blank path is the pre-tiering path read for read, and a failed plan lookup
  fails closed with the reservation's 503.
  `chat_budget_{input,output}_tokens` existed only inside the module, so a
  tfvars value for either was silently dropped; both are now declared at the
  root and passed through, and validation refuses `"0"`, which the chat code
  reads as a zero budget rather than as unlimited. Chat is not tier-aware.
  Staging lists every cap explicitly as `""`, including
  `identify_metering_enabled`, so the production-only enforcement is visible
  rather than implied.
- The pricing page and the landing plans band lead with the household wedge:
  priced per household, not per person. Competitors in this category bill per
  user and this app does not, and the headline, lede, and meta description said
  nothing about it. The page adds a "why a paid plan" band whose three claims
  are each checkable against code — per-household billing (one subscription per
  household id, and every tier has a member cap), raised caps, and nothing
  locked away on cancellation (over-cap records stay readable and editable, and
  `GET /me/export` is not plan-gated) — plus two FAQ entries for the questions
  asked before the ones about changing plans later: whether everyone in a
  household needs their own plan, and whether a credit card is required. Trial
  terms and the purchase path now sit with the grid instead of only in the FAQ
  far below, through a slot that renders only when real amounts do. Plan caps
  are the actual free-versus-paid difference, so they are set apart from the
  tier description rather than sharing its styling, which takes that text from
  7.6:1 to 12.9:1 contrast. No amount is hardcoded: prices stay API-sourced and
  both commercial gates still fail closed.

### Fixed

- Deleting an account now cancels the Stripe subscription of every household
  the user was the only member of. `DELETE /me` erased the household row that
  recorded the subscription and the only login that could reach the billing
  portal, so a deleted user kept being charged with no self-serve way to stop
  it. Subscriptions are per household, so leaving a household that keeps other
  members still never touches billing. The cancellation runs before any
  destructive step and fails closed: if Stripe cannot confirm the subscription
  is dead the deletion is refused with a 502 and nothing has been touched, and
  a retry is safe because an already-cancelled or missing subscription counts
  as done.
- Quiet hours are now evaluated in the browser's timezone for a user who never
  touched the Timezone field (#398). `GET /notifications/prefs` answers
  `timezone: 'UTC'` for an account that has never chosen one, and the reminder
  run evaluates the do-not-disturb window in that zone, so "22:00–07:00" saved
  by a user who filled in only the two times was a UTC window — the field's
  own helper text, "24-hour, your local time", was not true. The settings page
  only ever defaulted its _draft_ to the browser zone, and the server's `'UTC'`
  overwrote even that on load. On the first load that still carries the server
  default, the browser's `Intl` zone is now written through the same mutation
  Save uses — built from the persisted record, so no half-edited quiet hours
  are committed — quietly (no "saved" banner) and at most once per mount, so a
  deliberate choice of UTC in the same session is kept. A browser that cannot
  name its zone writes nothing and the field shows the stored `UTC`; a
  rejected write is shown, not hidden. The draft-sync effect now overwrites
  only the fields the server actually changed, so the background write cannot
  wipe a Start time being typed.
- The pricing grid no longer sells "Bulk import and export" as a Greenhouse
  feature (#398). `POST /plants/import` is open to every tier and bounded only by the
  plan's plant cap (which the caps line already states), and `GET /me/export`
  requires only a login — the "Nothing locked away" band on the same page
  already promises export to everyone. Because the bullets are cumulative
  ("Everything in Garden"), listing it under Greenhouse claimed the lower tiers
  lack it. The bullet moves to Seedling as "Import and export (CSV and JSON)"
  (es: "Importación y exportación (CSV y JSON)"). Nothing is gated — whether
  export should be restricted is a product decision this change does not make.
  API access, the adjacent Greenhouse bullet, is enforced
  (`backend/src/handlers/apiKeys/handler.ts`) and stays.
- The landing page no longer announces a pause directly above live prices. Its
  plans band branched on the registration kill switch alone, so with the
  commercial hold lifted it kept rendering "Start free; paid plans are paused"
  and "purchases and plan changes remain unavailable" above a `PricingGrid`
  publishing real, purchasable amounts — telling every visitor to the
  highest-traffic surface that they could not buy. The copy now keys off both
  gates, so a pause can never be announced over a selling catalog, and a guard
  test pins it: the band may claim paid plans are paused only while the hold is
  active, and may never publish an amount.
- The sitter-link list no longer shows an expired link as active. `status` is
  only the revocation flag, so a link whose window had closed stayed under
  "Active links" — with a live Revoke button — for the better part of a week,
  because the DynamoDB TTL keeps a three-day buffer past `expiresAt` and the
  sweeper lags behind that. Each link's state is now derived from its window —
  active, scheduled, expired, or revoked — and an ended window moves to a
  "recently ended" note that says access has stopped.
- "fern" no longer leads the pet-safety checker with a green "Boston fern is
  pet-safe" card above the genuinely toxic asparagus fern. Boston fern's bare
  `fern` alias put the non-toxic row in the exact-match tier, outranking every
  later tier; that alias is removed, the mirror of the note already on
  asparagus fern, and "fern" still reaches Boston fern through the substring
  tier. The nine new rows are deliberately narrow for the same reason:
  money-tree carries no `money plant` alias, because in ordinary use "money
  plant" more often means pothos or jade, both toxic and both already in the
  table; parlor-palm carries no bare `palm`, because sago palm is in this table
  and causes often-fatal liver failure; christmas-cactus carries no bare
  `christmas`, because poinsettia is toxic; and bird-of-paradise carries none
  of Caesalpinia gilliesii's common names, a different and harsher shrub sold
  under the same name. Ties inside a matching tier now break toxic-first, since
  the page renders every match but the first card is the one a worried reader
  acts on; this re-orders within a tier only and never widens a result set.
- `subscription_activated` is no longer read as revenue. Every subscription
  checkout carries `trial_period_days: 14`, so the event counts trial starts,
  not payments — which is why "has anyone ever paid us?" had no answer anywhere
  in the system. It keeps its real meaning (a trial began, or a lifetime
  purchase completed, the one case where it is money), and `docs/analytics.md`
  stops listing `customer.subscription.created` among its triggers, which the
  code has never emitted on, and stops answering "No"/"Partly" to the trial
  conversion and churn rows. The unwired `subscription_canceled` stays unwired:
  its documented trigger is "opened the billing portal", which is not a
  cancellation. `docs/billing.md` also stops saying the checkout events set
  status to active, which #380 removed.
- `experiment_viewed` reached no rail at all, so the landing hero A/B test had
  produced zero rows. It is fired by an anonymous visitor and every rail is
  identity-gated; pre-identity events are now held in memory and replayed at
  sign-in. Nothing is sent while the visitor is anonymous, so the privacy
  posture is unchanged and the anonymous-visitor characterization tests still
  assert zero network traffic. This buys the numerator, not the denominator,
  and the docs say so.
- Two committed figures were stale and are now corrected and gated.
  `docs/quality-audit.md` stated the handler-route count as 66, in two places,
  while describing that count as CI-enforced — the enforcement was real and
  green, it simply never reported its number back to the document quoting it,
  so the audit sat 39 routes stale (the handlers expose 105) while truthfully
  describing a passing gate. `README.md`'s standards-conformance row claimed
  root and workspace versions were "aligned at 0.23.0" when they had moved on;
  `validate-store-release.mjs` enforces that three-way alignment but never
  reads the README and is in neither `verify` nor CI. Both figures are now
  re-derived on every `npm run verify`.
- The pricing grid's CTA labels and cadence suffixes are translated. They went
  through hardcoded English while the catalog already carried the keys in both
  locales, because they sit inside JSX expressions, which the hardcoded-string
  scanner does not inspect.
- The dashboard climate card no longer renders a failed read as a calm night
  (#351). `if (!data) return null` put a failed climate read in the same
  silence as "no household active" and "no location saved with the integration
  off", so a household that would have seen the freeze warning — "Low of X°C
  tonight. Bring tender plants indoors.", the only place the product carries
  it — saw nothing at all, and nothing is what a night with no warning looks
  like. A settled read with no data now says the local climate could not be
  read and that tonight's frost, heat, and rain warnings are unchecked rather
  than clear. Still-in-flight stays silent, and the genuine "no location"
  states are unchanged.
- Pet toxicity no longer rides on the care-guide fetch (#350). `CareGuideCard`
  was the only surface on the plant detail page carrying pet toxicity — the one
  fact its own docstring called "actively dangerous to miss" — and its
  `if (isLoading || !data) return null` discarded a failed or slow
  `/species/:id/guide` read in a way indistinguishable from "this species has
  no guide". Toxicity moved to `PetToxicityNote`, which the plant page now
  mounts on its own read, and which already distinguishes "couldn't check" from
  "unknown" from "toxic" so none of them can resemble confirmed-safe. The note
  takes a `context` so a plant already in the household is not told it can
  still be added. `CareGuideCard` keeps only the long-form guide, and now
  separates a failed read (says so) from a provider `null` (renders nothing,
  because that is a real answer).
- A failed API-key read no longer renders as "Active keys (0)" / "No keys yet."
  (#349). Only `isLoading` was ever checked, so an admin hitting a transient
  read failure saw the zero-state while keys issued earlier still granted
  programmatic read/write access to household data, with no error shown and no
  Revoke control to reach them. The list now says the read failed and that any
  key issued earlier is still active until revoked; the count is published only
  when it was actually read. A genuine empty is unchanged.
- The committed branch ruleset would have locked the repository owner out if
  anyone applied it. `.github/rulesets/main.json` carried `"bypass_actors": []`,
  and the file is a complete, postable ruleset document, so following this
  repository's own artifact — `gh api -X POST .../rulesets --input` — would
  have left `main` with required checks, blocked force-push, and blocked
  deletion applying to the owner with no exception, including the rule that
  would let her repair it. GitHub returns 201 for such an apply, so nothing
  warns you; this exact mistake locked the owner out of eighteen repositories
  in this portfolio. The file now carries the owner's standing bypass,
  `{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }` —
  the admin role, `always` rather than `pull_request`, because a bypass that
  only works inside a pull request is no use when the pull request is the thing
  that is wedged. `.github/rulesets/README.md` reverses its previous "no bypass
  actors" reading explicitly rather than deleting it, records the deliberate
  divergence from the vendored `CI-CD-STANDARD.md` CICD-15 and §5.1, and states
  that the live ruleset still disagrees (it names the owner as a user with a
  PR-only bypass) along with the owner-only command that reconciles it. No live
  setting was changed by this repository.
- `docs/testing.md`'s test-case snapshot was five cases stale for the frontend
  unit layer (the file-count gate does not check cases). Re-measured and
  re-dated.
- `docs/testing.md`'s backend-unit snapshot was in turn one case stale for the
  same reason. Re-measured and re-dated alongside the file counts the ruleset
  guard adds.

## [0.23.4] - 2026-09-03

### Fixed

- A household on a free trial is now told so, and told when its first charge
  lands. `checkout.session.completed` stamped `status: 'active'` on every
  subscription, which is state that event does not carry — it references the
  subscription by id — and is wrong for every checkout that starts a trial,
  which is all of them. Whichever of the two webhook events arrived last won,
  so a trialing household could be recorded as active and never see the trial
  marker or its end date. `customer.subscription.created`/`.updated` now own
  the field, because they are the events that actually carry it.
- The conversion analytics no longer depend on that stamp. Emitting
  `subscription_activated` was gated on `status === 'active'`, which worked
  only because checkout stamped it — so removing the stamp would have silenced
  the event for every trial subscription. De-duplication now keys on the
  checkout event itself, which is the thing that is genuinely one per
  purchase; `customer.subscription.created` is excluded because it always
  accompanies a checkout.
- Both double-billing guards now fail closed on an unknown status. Between
  `checkout.session.completed` (which records the subscription id) and
  `customer.subscription.created` (which records its status) a household holds
  a live subscription its row cannot yet describe. Reading that gap as "no
  subscription" would let a second one start alongside the first.
- The client's live-subscription status set matches the server's. It was
  missing `unpaid` and `paused`, so a household in either state was offered a
  purchase button the server refuses with a 409.
- Production deploys work again past 50 Lambda versions. The rollback snapshot
  read the newest published version with `aws lambda list-versions-by-function
--query`, and the AWS CLI paginates that call at 50 while applying `--query`
  to each page — so once a function crossed the boundary it returned one
  maximum per page (`49\n50`) and `get-function` rejected it as an invalid
  qualifier. It is a pre-existing latent defect that fired the first time a
  function accumulated 51 versions; the snapshot runs before any code ships,
  so the failed deploy changed nothing in production.

## [0.23.3] - 2026-09-02

### Added

- Paid plans are available on the hosted site. The commercial hold recorded in
  `commercial-status.json` was lifted on 2026-09-01, and this release opens the
  second, independent gate: `payments_enabled = "1"` in the production
  environment. Both must be open for any payment activity — the runtime gate
  alone is the fastest kill switch, since returning it to `"0"` and applying
  stops all new purchases without a code change or a frontend deploy, and fails
  before Stripe or DynamoDB is reached.
- The paid-plan purchase surface itself: `PaidPlanGrid`, the month/year/lifetime
  interval selector, and admin-gated checkout and billing-portal controls in
  Settings. The billing API existed but was unreachable — nothing in the
  frontend called `POST /billing/checkout` or `/billing/portal` — so lifting the
  flag alone would have produced an empty pricing page rather than a store. The
  code shipped in `v0.23.2` with both gates shut; this release turns it on.
- `payments_enabled`, wired root → module → Lambda environment, defaulting `"0"`
  at every layer and validated to exactly `"0"` or `"1"` so a tfvars typo fails
  the plan instead of silently disabling a launch that looks enabled. Three
  preconditions on `terraform_data.commercial_gate_guard` fail the plan when the
  runtime gate opens without the repository gate, with blank Stripe
  configuration, or with a live key against unconfirmed price ids. They are
  preconditions rather than `check` blocks deliberately: a check block only
  warns, and CI runs `plan -out` then `apply tfplan`, so nobody would read it.

### Fixed

- A lifetime purchase can no longer be destroyed by a later subscription. A
  one-time purchase has no subscription id, which made lifetime ownership
  invisible to both guards that prevent paying twice — so a household that paid
  $149 outright could be sold a subscription for a tier it already owned, and
  cancelling that subscription dropped it to Seedling with no refund path. The
  tier is now recorded durably as `lifetimePlanId` and acts as an entitlement
  floor that subscription events never clear.
- A cancelled subscription now says so. Stripe does not delete a cancelled
  subscription immediately — it sets `cancel_at_period_end` and keeps serving
  until the period ends, so `status` stays `active`/`trialing` throughout.
  Nothing read that flag, so cancelling produced no visible change anywhere in
  the app and reasonably looked like it had failed.
- Entitlement is re-read after returning from checkout. It is the one piece of
  state a webhook changes behind the user's back, and the app-wide query
  defaults (five-minute `staleTime`, `refetchOnWindowFocus` off) meant a
  household that had just paid kept seeing its old plan — which invites paying
  again.
- IAM resources get a tag set IAM will accept. The cost-allocation tags
  deliberately carry both `Project`/`project` and `Environment`/`environment`
  because Cost Explorer tag keys are case-sensitive; IAM compares them
  case-insensitively and rejects the pair. It only fires on create, so it stayed
  latent until an environment was rebuilt from an empty state — and would have
  failed the same way for a production rebuild, making it a disaster-recovery
  defect rather than a staging inconvenience.

## [0.23.2] - 2026-08-18

### Changed

- The model card stops publishing its two eval figures as though they were
  measurements. `recall@3 = 1.0` and `own-chunk-top-1 = 1.0` are 1.0 by
  construction: the eval uses each corpus chunk's own precomputed embedding as
  the query vector, and cosine(x, x) = 1 is the maximum possible score, so the
  target cannot rank anywhere but first. That caveat existed only in
  `evals/eval-baseline.json`'s `method` field and never reached the card. The
  `model-index` front matter now carries self-describing metric ids and the
  caveat inline, and the narrative explains what the numbers are a floor on.
- The model card's benchmark size is corrected from "22-question" to the real
  134 items, of which 102 corpus-class items are scored and 32 adversarial
  items are labelled but ungraded. The count went stale on 2026-07-17 and
  survived a month; the card's recheck cadence now includes any change to
  `evals/benchmark.jsonl` or `evals/eval-baseline.json`, and
  `backend/tests/eval/ragRetrieval.eval.test.ts` fails if the front matter
  disagrees with either file.
- `docs/roadmap.md`'s "Measured values" line carried the same two figures, the
  same "22-question", and a measurement date of 2026-07-05 — twelve days before
  the baseline it cites was generated. It now dates the baseline correctly,
  states the by-construction caveat, and splits the standard's target into the
  half that is met (question count) and the half that is not (live scoring).
- `evals/eval-baseline.json`'s `method` said `ownChunkTop1Rate` is ~1.0 by
  construction but did not say the same of `recallAt3`, which the same cosine
  identity forces. It now says both.
- The vendored portfolio standards in `docs/standards/` are refreshed to
  v2.0.0 (#310). Documentation only — no CI gate, workflow, or code changed as
  part of the refresh.

### Fixed

- The per-task streak chip on the plant detail page no longer states a capped
  count as a measured one. #328 fixed `CareReportCard` because
  `plant.recentCompletions` is capped at `RECENT_COMPLETIONS_LIMIT` rows across
  ALL of a plant's tasks; `PlantDetailPage`'s `TaskRow` consumes that same array
  through the same mechanism and was not touched, so it kept the same defect one
  component over. A plant watered forty consecutive times could render at most
  "10-cycle watering streak", and fewer than that in practice — those ten slots
  are shared with the plant's fertilize/prune/repot rows, so a multi-task plant's
  water streak is bounded by however many water rows survive the interleave.
  `computeStreak` now returns a `StreakReading` (`cycles` plus `truncated`)
  instead of a bare number: `truncated` is set when an unbroken run consumes
  every row this task has in a window that came back full, which is precisely
  the case where the window — not the household's care — is what ended the run.
  `streakLabel` renders that as "10+ cycle watering streak (within the last 10
  logged)" rather than "10-cycle watering streak", the same
  state-the-window treatment `CareReportCard`'s labels got. An exact reading is
  unchanged. Note the remaining gap, which this does not close: when a task's
  newest completion is crowded out of the shared window entirely, the chip still
  renders nothing — absence rather than a false claim, but not distinguishable
  from "no streak".
- `PageHeader`'s underline test no longer matches the SVG through a
  `svg[viewBox="…"]` CSS attribute selector. jsdom 30 stopped matching
  camelCase SVG attribute names in selectors — on 29.1.1 both the camelCase and
  lower-cased spellings match, on 30.0.1 neither does, while
  `getAttribute('viewBox')` still returns the value on both — so the assertion
  was engine-dependent, not a statement about the component. It now reads the
  attribute, the way the neighbouring assertion in the same file already did.
  This is what fails `Test Frontend` on the jsdom 30 bump (#312); with this on
  `main`, that bump goes green on a rebase.
- The RAG grounding guard no longer reports a pass for an answer it checked
  nothing in. It returns a three-state verdict (`verified` / `unverified` /
  `ungrounded`) instead of a boolean `grounded`, reports numeric content it
  could not resolve to a checkable claim shape, and logs each verdict under its
  own event name so `chat_grounding_checked` can no longer describe an answer
  with zero claims checked. Word-quantity dose instructions ("half strength",
  "double the dose", "twice the concentration") are now checked against the
  retrieved corpus like numeric doses — the corpus gives its dilution guidance
  in words, so a digit-only guard was still blind to it. Blocking behaviour is
  unchanged except that an unsupported word-quantity dose now blocks too. See
  [ADR 0009](docs/adr/0009-three-state-grounding-verdict.md).
- An unreadable plan-usage counter no longer satisfies the plan limit. The
  frontend's over-limit check was a boolean, so "under the cap" and "we could
  not read the count" were the same answer and the post-downgrade warning
  simply never appeared. `evaluatePlanLimits` replaces it with `within` /
  `over` / `unknown` per dimension, and billing settings now shows a third,
  distinct notice saying the check could not be made rather than staying
  silent. A genuine zero is still `within`.
- The dashboard status line no longer publishes a failed plants or tasks read
  as `0`. It keyed on the loading flag alone, so a fetch error rendered
  "Plants 0 / Due today 0 / Overdue 0" — indistinguishable from a genuinely
  empty household, and reassuring in exactly the wrong direction. Missing data
  now renders the same em dash the loading state uses.
- Activity rows for leaf-health checks recorded before the `demo` flag existed
  no longer claim a check ran. Those rows are indistinguishable from demo
  results — and a demo result means no image was analysed — so the feed now
  states the request and says the record does not show whether a real analysis
  or a demo result produced it, with a question-mark icon instead of the
  success tick. Rows that carry `demo: false` are unchanged.
- Climate tips no longer call OpenWeatherMap's outdoor reading "Indoor
  humidity". The reading is taken at the geocoded city centroid and there is no
  indoor sensor anywhere in the product, so the low-humidity tip now says
  "Outdoor humidity is around N%" and infers the indoor consequence in words
  instead of attaching the number to a room it never measured; the
  high-humidity tip is labelled the same way, and the dashboard climate card
  reads "N% outdoor humidity". A regression test asserts no tip puts a measured
  percentage next to the word "indoor". The `get_household_climate` chat tool
  describes its payload as outdoor for the same reason: the model was handed a
  bare `humidity` field and could phrase it as the user's room.
- The care report no longer presents a windowed count as a lifetime one.
  `GET /plants/{id}` returns at most ten completions across all of a plant's
  tasks, so "Total completions" and "Longest streak" were both capped at ten by
  construction for any well-used plant. Both are now labelled with the window
  they can actually see, the card says older care is not counted, and the
  window size is a named constant on both sides of the API instead of a bare
  `10`.
- `docs/observability.md` no longer tells the on-call to confirm `/health`
  "reports every component healthy". `/health` hardcodes `auth` and `mail` to
  `unknown` — deliberately, since neither is probed — so that step could never
  be satisfied, and a green `/health` is not evidence that Cognito or SES
  recovered.

### Security

- Bumped the `js-yaml` override from `^4.2.0` to `^4.3.1`, closing
  GHSA-5p4m-2wfm-xmqj (quadratic CPU consumption in `!!omap` resolution, high,
  affected `>= 4.0.0, < 4.3.1`). The old range resolved to 4.3.0. js-yaml
  reaches the graph transitively through `cosmiconfig` and `@lhci/utils`, so
  Dependabot cannot open this bump itself — the override is the only lever. The
  only package change in the lockfile is `js-yaml` 4.3.0 to 4.3.1. Scope is
  development, so `npm audit --omit=dev --audit-level=high` was already passing
  and is unaffected.
- The production deploy workflow's advisory tag-signature check can now
  actually verify a release tag. `git verify-tag` ran with no SSH
  allowed-signers mapping configured, so every tag — signed or not — took the
  warning path. The maintainer's SSH signing key (the key GitHub shows as
  verified, and the same entry `outcome-receipts` releases are authorized
  against) is now committed at `.github/allowed_signers`, and the check points
  `gpg.ssh.allowedSignersFile` at it before verifying. The step stays advisory
  (REL-08); it should flip to blocking once this release's signed tag verifies
  in CI.

## [0.23.1] - 2026-08-09

### Changed

- RAG grounding now recognizes care quantities that carry volume, mass,
  dilution, repetition, and fertilizer-ratio units, verifies unit-aware dose
  evidence (including `per` and `/` denominators), and records content-free pass
  telemetry with checked-claim and source counts. Zero-claim passes are now
  observable instead of looking identical to a substantive verification.
- Frontend coverage floors ratcheted from lines 65 / statements 64 / branches
  59 / functions 57 to lines 76 / statements 75 / branches 65 / functions 66
  (`frontend/vitest.config.ts`), backed by new unit coverage for the chat SSE
  stream parser, the browser telemetry vitals and error rail (including the CLS
  session-window rule and the per-session error cap), client-side image
  downscaling, the browser-notification wrapper, locale formatting, the
  UI-preferences store and its v0→v1 migration, and the previously untested
  task, household, space, species, climate, sitter, and photo-upload service
  paths. No production code changed.
- `npm run verify` (and so `make verify` and the pre-push hook) now runs
  `test:coverage` rather than plain `test`, so both workspaces' coverage floors
  fail locally at the same point CI's `Test Frontend` / `Test Backend` jobs
  would fail them.
- Backend coverage floors ratcheted from lines 80 / statements 80 / branches
  71 / functions 80 to lines 82 / statements 81 / branches 74 / functions 82
  (`backend/vitest.config.ts`), reflecting coverage that feature/fix PRs
  already added since the last rung (2026-07-05) rather than a dedicated
  coverage push. No production or test code changed.

### Fixed

- Household activity now gives every emitted event type a descriptive row,
  includes imports in the Plants filter, and labels demo leaf-health results
  as canned rather than durable real assessments. The event renderer and
  filter exhaustively cover the frontend's declared event union while retaining
  a safe fallback for older clients that receive a newer event type.
- Billing usage counters now preserve genuine zeroes while reporting missing
  or unreadable household counters as unavailable through the additive
  `usageDetail` response. The legacy `usage` object remains numeric-only and is
  omitted when incomplete, keeping cached clients safe; current plan meters no
  longer show unknown usage as `0`, and a known over-limit count still surfaces
  the post-downgrade warning when the other count is unavailable.
- README's Code Quality conformance row claimed the backend "clears 80% on
  all four coverage metrics" — untrue for branches, which measured 73.77% at
  the 2026-07-05 rung this claim was written against and 76.01% today. The
  row now states backend branches and all four frontend metrics remain below
  the 80% target, matching the honest-not-aspirational standard the same
  section commits to.
- The plant-name nursery's unit spec pinned its random draw. Previously it used
  the real `Math.random`, so whether the "reroll until the name differs" retry
  ran — and therefore the repo's measured frontend coverage — changed between
  otherwise identical runs.
- Removed superseded repository-visibility language from the CI workflow; its
  comments now describe the active public CodeQL path directly.

## [0.23.0] - 2026-07-25

### Added

- Red-team injection corpus for the chat tool layer
  (`evals/redteam/injection-corpus.json`, 9 payloads mapped to OWASP LLM01/02/06)
  and a CI-gated test asserting prompt-injection strings stored in
  user-controlled fields cannot widen a tool's household scope, leak PII to the
  model, or coerce a write past the confirm-card validation. Dated report in
  `docs/audits/red-team-2026-07-17.md`. This is the offline/data-layer slice of
  the AI-eval standard's §2 red-team requirement; live-model refusal scoring,
  Promptfoo, and Garak remain waived and not built.
- AI-eval benchmark expanded from 22 to 134 items across four labeled
  behavior classes (102 corpus-anchored real-user questions at 8–10 per
  article, 12 should-refuse, 10 out-of-corpus/abstain, 10
  household-data/tool-use), with new CI gates: schema validation,
  per-article and per-class count floors, and `expectedTools` checked
  against the live tool registry. Retrieval metrics still use the anchor-
  chunk-embedding proxy; the adversarial labels are data for the future
  generation-layer eval and are not yet scored against live model output.
- Production-bundle browser coverage for notification permissions, service
  worker activation, foreground reminder timing, photo upload recovery,
  account deletion, cutting grafts, sitter care, and public integration
  boundaries across Chromium, Firefox, WebKit, Mobile Chrome, and Mobile
  Safari.
- Version-aware production smoke cleanup that removes the exact disposable
  test object, every historical S3 version, and every delete marker even when
  application-level account cleanup fails.

### Changed

- Notification delivery now records channel-scoped outcomes and leases so a
  transient email, SMS, or push failure retries only that channel without
  duplicating successful sibling deliveries.
- Integration availability is reported conservatively: disabled or
  unconfigured weather, identification, pet-safety, telemetry, chat, and
  notification providers expose an actionable degraded state instead of
  claiming success or inventing data.
- Browser notification permission and foreground reminder state now
  resynchronize on focus, visibility changes, and page restoration.

### Fixed

- Account deletion now removes the Cognito user, every household/global
  DynamoDB record, memberships, assignments, history references, photo
  objects, historical object versions, and delete markers.
- The generated production service worker imports the background push handler,
  ships both files with no-cache headers, cleans stale subscriptions, validates
  push endpoints, and routes reminder deep links to the due queue.
- Plant photo creation recovers from a failed upload without creating a
  duplicate plant, then performs a real retry PUT, confirmation, byte fetch,
  and decoded-image render.
- Chat turns are idempotent under retries, stream configuration is deployed
  consistently, external-provider budgets are atomic, and local HTTP behavior
  matches the production route surface.
- Quiet hours, per-channel delivery, welcome-email deduplication, reminder
  aggregation, household switching, public invite/share/sitter boundaries,
  keyboard focus, 320px reflow, reduced motion, and modal accessibility now
  behave consistently across supported browser engines.

### Security

- Push endpoints are restricted to approved HTTPS provider origins with
  request caps, timeouts, and stale-subscription cleanup.
- Plant-identification uploads stay privacy-bounded, external API budgets fail
  closed under concurrency, and deployment IAM now grants only the additional
  Cognito/S3 version operations required for complete erasure.

## [0.22.0] - 2026-07-19

### Added

- Free Seedling account registration is open again for households with up to
  10 plants and 6 members; paid plans and every payment path remain disabled.

### Changed

- Bitter Variable replaces Gloock across the site and generated brand assets.
- The landing page no longer uses its greenhouse-grid background, animated
  hero sprigs, or decorative section-divider artwork.

### Fixed

- SMS reminder bodies are now trimmed to the promised 140-byte budget by
  UTF-8 bytes rather than UTF-16 code units, so accented Spanish text or the
  streak emoji can no longer blow past the byte budget or split an emoji
  surrogate pair mid-code-point.

## [0.21.0] - 2026-07-16

### Added

- First-party, privacy-bounded browser RUM now captures sanitized errors and
  LCP/CLS/INP with normalized route and release correlation; authenticated,
  typed product events now reach CloudWatch even without PostHog credentials.
- A machine-checked 28-day SLO contract, health-excluded application RED
  metrics, per-route dashboard panels, fast/slow availability burn alerts,
  frontend error alerts, and DynamoDB write-throttle coverage.

### Fixed

- CloudWatch HTTP API panels and alarms now use the real API ID and the `4xx` /
  `5xx` metric names instead of querying nonexistent REST API series.
- Notification settings now expose actual SMS capability and hide the phone
  verification flow while production delivery is disabled, preventing the
  user-facing 503 loop.
- Dashboard, plant, task, and notification queries wait for a valid household
  context before issuing authenticated requests.

## [0.20.0] - 2026-07-16

### Added

- The dashboard now shows a bilingual Shared-care pulse until the household
  has a plant, an active care task, a second member, and a recent task
  completion by someone else. The ordered care-vine links directly to the
  next missing step and can be hidden on the current device for 30 days.
- Shared-care pulse actions emit a privacy-preserving, household-grouped
  analytics event so the collaboration activation hypothesis can be measured
  without sending plant, household, or member names.

## [0.19.0] - 2026-07-16

### Added

- The active Spaces view is now an operational care route, ordered inside to
  outside to unplaced, with each stop showing plant count, overdue or due-today
  work, next care, recorded conditions, usual caregiver, and current seasonal
  move suggestions.
- Every space card links to a URL-addressable scoped care round that preserves
  the existing task filters, claiming, vacation coverage, climate advice, and
  completion controls.
- Focused browser coverage now verifies the complete space-to-task flow across
  the CI browser matrix and includes a WCAG 2.2 AA scan of the populated view.

### Changed

- Operational space summaries are composed from existing household-scoped
  projections only when the active Spaces view is open, adding no migration,
  summary row, background job, or backend authorization surface.

### Security

- Public repository visibility is restored after a clean full-history Gitleaks
  scan and separate inspection of archived Lambda bundles. GitHub secret
  scanning, push protection, and private vulnerability reporting are active
  with no open secret alerts.
- CodeQL and zizmor again publish findings to the public repository's code
  scanning view, and OpenSSF Scorecard public publishing resumes. The
  commercial hold and every runtime signup/payment control remain unchanged.

## [0.18.0] - 2026-07-16

### Added

- Spaces can record whether outdoor plants are exposed to rain, so weather
  guidance targets only plants whose current placement is actually affected.
- Plants can remember preferred summer and winter spaces and receive an
  explicit, latitude-aware move suggestion when the active season changes.
- Placement-fit guidance can flag conservative light-level mismatches and
  known pet-toxicity concerns using optional space conditions.
- Active sitter links now show each due plant's current space and short
  placement note without exposing household climate data, private notes, or
  member identity details.
- Spaces can name a usual caregiver. New tasks for plants in that space inherit
  the caregiver while explicit assignments continue to win and existing tasks
  remain unchanged.

### Changed

- Legacy spaces hydrate safe rain, light, pet-access, and caregiver defaults,
  so the new placement features require no data migration or backfill.

## [0.17.0] - 2026-07-15

### Added

- Households can define named indoor and outdoor spaces, browse plants by
  placement, and see unplaced plants without relying on free-form tags.
- Care Rounds group due work by space so a caregiver can finish one physical
  area at a time and track progress through the round.
- Task rows now show each plant's current space and indoor/outdoor context.
- Quick-move and bulk-move workflows let caregivers relocate plants between
  spaces while recording the placement change consistently.

### Changed

- The new move workflow remains a lazy-loaded chunk; the aggregate bundle
  budget is recalibrated with tight headroom while initial JS, vendor, and CSS
  budgets remain unchanged.

### Fixed

- CodeQL and zizmor now retain SARIF artifacts on private repositories without
  requiring the unavailable GitHub Advanced Security upload endpoint.
- Production UI browser assertions now match the commercial-hold pricing and
  billing headings.

## [0.16.3] - 2026-07-14

### Security

- A repository-wide commercial hold now fails closed across public plan
  surfaces and both Stripe session-creation paths. Public UI and API responses
  expose no prices, billing intervals, purchase, upgrade, or paid-plan
  registration controls; production price IDs remain blank; and tests pin the
  shared status, exact runtime gate, and Terraform invariants. The commercial
  hold does not gate Stripe webhook code used for cancellation and other
  already-originated event processing.
- The same hold now closes new-account acquisition end to end: public surfaces
  and social artwork contain no registration CTA or free/no-card offer, the
  stable registration route has no form, public signup returns `503` without a
  Cognito call or local mutation, and Cognito independently requires
  administrator-created users. Existing login, recovery, and already-pending
  confirmation/resend flows remain available.

### Changed

- Dependency maintenance now advances every compatible in-range package,
  migrates both workspaces to Zod 4, aligns Commitlint and CodeQL action
  versions, removes the obsolete external UUID declarations, and records a
  complete disposition for all 84 historical Dependabot PRs. Tailwind 4 and
  TypeScript 7 remain explicit major-version holds, not silently skipped bot
  work.
- Dependabot's GitHub Actions cadence returns to weekly now that every required
  Node 24-compatible action major has landed; the configured dependency labels
  now exist in the repository.
- The legal pages now state the minimum account age and describe temporary
  sitter-link access in plain language; the DPIA and profile documentation now
  match the implemented deletion-time anonymization behavior.
- Current conformance and accessibility documentation now replaces stale
  pre-remediation claims, and `make verify` provides the documented local CI
  parity entry point.
- Chat now has a Terraform-controlled incident kill switch that stops new sync
  and streaming model turns before any spend or persistence while leaving
  history/reporting available.
- Architecture and quality records now recognize the shipped schedules,
  Perenual integration, and successful PITR drill instead of carrying them as
  unfinished work.

### Fixed

- RAG answers now block unsupported quantitative care claims before they are
  persisted or delivered; streamed RAG text waits for the same grounding check.
  A later authoritative plant/task/climate result now joins historical RAG
  evidence through explicit numeric facts and collection counts, so its real
  numbers pass without letting incidental digits in IDs/dates—or a fabricated
  count—disable blocking.
  Tool outputs and history replay cross a recursive PII-field sanitizer, raw
  tool exception messages no longer enter prompts/logs, and repeated identical
  tool calls reuse the validated result instead of duplicating work/cards.
- The responsible-tech, model-card, and EU-transparency records now reflect the
  disclosure footer and authenticated Playwright assertion that were already
  present, rather than carrying a stale open-gap claim.
- Long chat conversations follow DynamoDB cursors newest-first and restore the
  bounded window to chronological order, so a page boundary—or the defensive
  ten-page cap—cannot hide the actual tail of a thread.
- Session restore now uses the still-valid refresh token before logging a user
  out when the short-lived ID token has expired, and rejects syntactically valid
  `/auth/me` payloads that do not match the complete user shape.
- Lifetime checkout metadata names the exact recurring subscription it
  replaces. The webhook first wins the out-of-order DDB condition and stages a
  private retry marker, then cancels that exact subscription; a stale lifetime
  event cannot cancel a newer subscription, a Stripe failure remains safely
  retryable after the public subscription ID is cleared, and a fully recorded
  redelivery cannot cancel the same subscription twice. Concurrent duplicate
  deliveries now elect one cancellation worker through an expiring atomic
  claim, backed by an event-stable Stripe idempotency key.
- A crashed seasonal pest evaluation removes its daily claim marker so a later
  invocation can retry instead of silently suppressing that day's alerts.
- The checked-in inbound-mail Lambda archive now matches its byte-safe,
  scan-verdict-enforcing source instead of deploying the older UTF-8-reencoding
  forwarder.
- The landing-page visual regression gate now pins its A/B experiment bucket,
  removing random control-versus-treatment screenshot failures.

## [0.16.2] - 2026-07-12

### Added

- Store-ready iPhone, iPad, and Android screenshots, app icons, Play feature artwork, localized
  listing metadata, and deterministic validation/generation scripts for repeatable releases.
- Public support and account-deletion pages, in-app AI response reporting, native privacy
  disclosures, and complete account-cleanup coverage for store policy compliance.

### Changed

- Native networking now uses the platform HTTP stacks, mobile billing surfaces are purchase-free,
  and release builds strip source maps before syncing into the iOS and Android shells.
- iOS and Android release versions advance to `0.16.2` (build/version code `1602`).

### Fixed

- Store screenshot generation is isolated from the default Playwright suite so release-only
  projects cannot be discovered by general CI browser profiles.

## [0.16.1] - 2026-07-12

### Fixed

- Production deployment no longer passes the iOS `capacitor://` WebView origin to AWS-managed
  CORS APIs, which reject custom URL schemes; AWS retains the valid web and Android origins while
  the backend prepares exact-origin preflight handling for the complete native allowlist.
- CORS preflight metadata now includes the implemented `PATCH` method and all four supported
  request headers, with exact-origin tests for web, iOS, Android, and rejected callers.
- Streaming chat now advertises only its `POST` contract, rejects other non-preflight methods,
  and refuses wildcard CORS configuration so origin-policy drift fails closed.

## [0.16.0] - 2026-07-12

### Added

- Native iOS and Android app shells (Capacitor) wrap the existing web app so it can ship to the
  App Store and Play Store; build flow and store-submission checklist live in `docs/mobile.md`.
- Inside the mobile apps, the notification settings device toggle registers a native push device
  token with the backend (capture-only groundwork — reminder delivery to native devices ships
  with the APNs/FCM sender).
- Feature-flagged, server-to-server Sprout integration for corpus-grounded plant-care answers,
  with HMAC authentication, minimized household context, nickname/contact redaction, citation
  persistence, and a temporary fallback to the existing assistant.
- Independent application-domain and Route 53 hosted-zone configuration, allowing an app
  subdomain without treating it as its own hosted zone or automatically creating a `www` alias.
- A deterministic vector-first brand pipeline that regenerates and verifies every web, PWA,
  social, iOS, and Android image derivative, including Android 13 monochrome launcher support.

### Changed

- Billing inside the mobile apps is read-only for store payment compliance: plan checkout and
  subscription-management actions stay web-only, with a neutral notice shown in the apps.
- The API's CORS allowlist now also accepts the mobile shells' origins, and the layout respects
  device safe areas (notch, status bar, home indicator) on edge-to-edge screens.
- The interface now uses one greenhouse identity across navigation, plant placeholders, empty
  states, launch screens, app icons, social previews, and native shells, replacing the remaining
  Capacitor template artwork and inconsistent legacy marks.
- Public, authentication, onboarding, dashboard, and plant surfaces now share a brighter
  greenhouse-glass visual system with stronger mobile navigation, contrast, typography, and
  accessible decorative semantics.
- The public OpenAPI contract now documents the implemented, opt-in `write:tasks` complete and
  snooze endpoints instead of incorrectly describing v1 as read-only.

### Fixed

- Notification artwork now resolves from the shipped brand path, and the stacked BrandMark
  variant no longer points to a missing file.

## [0.15.4] - 2026-07-11

### Fixed

- The edit-plant species test now waits for observable remote lookup results instead of racing a fixed delay during release builds.

## [0.15.3] - 2026-07-11

### Added

- Plants can be archived without losing tasks, photos, care history, or propagation lineage, then restored through the cap-safe lifecycle flow.
- Archive and restore transitions now appear in the household activity story and emit a lifecycle analytics event.

### Changed

- Plant removal now leads with the reversible archive action, past-plant cards show their lifecycle state, and inactive care schedules render as paused and read-only.

## [0.15.2] - 2026-07-11

### Added

- Plant name suggestions now recognize 14 plant families from common and botanical species names, tailor every personality style to the match, and show localized species context in the name nursery.

## [0.15.1] - 2026-07-11

### Added

- Public pages now publish route-specific Open Graph, Twitter, canonical, robots, breadcrumb, and structured application metadata for stronger search and link previews.
- Stripe Tax can be enabled explicitly after registrations and product tax codes are configured, with deployment wiring and operator documentation included.

### Fixed

- Checkout attempts now carry household-scoped idempotency keys, preventing duplicate Stripe sessions during transport retries.
- Delayed lifetime payments grant access only after Stripe confirms payment, and replacing an existing subscription retries safely if cancellation is temporarily unavailable instead of risking continued billing.

## [0.15.0] - 2026-07-11

### Fixed

- The pricing billing-interval toggle overflowed a 320px viewport on the landing page (WCAG 1.4.10), surfaced by the new reflow spec. (The page-header action-row reflow fix originally on this branch was superseded by the broader mobile-first rework in 0.14.1.)

### Added

- A playful “Name Nursery” when adding plants, with punny, distinguished, chaotic, sweet, and species-aware suggestions; preview-and-reroll controls; and localized English and Spanish interface copy.
- Playwright a11y specs closing the A11Y-07/08/09 audit gaps: keyboard-only path (login → skip link → complete a due task, with a visible-focus-ring assertion), `prefers-reduced-motion` behavior (both the `motion-safe:` variant and the global freeze rule), and 320×256 reflow across public + authenticated routes.
- Backend tests pinning the structured-logging contract (OBS-09/10/12): every pino record is one `jq`-parseable NDJSON line with `service`/`env`/label-`level`/`msg`, `withRequest` binds `requestId`/`userId`/`householdId`/`traceId` onto child records, and `loggingMiddleware` correlates the parsed X-Ray root id from `_X_AMZN_TRACE_ID` into request-scoped logs. `createLogger()` factory extracted so tests exercise the real serialization path.
- `.github/workflows/e2e-crossbrowser.yml` — weekly (plus on-demand `workflow_dispatch`) run of the full Playwright e2e + a11y suite on firefox and webkit, closing the QM-03 compatibility gap (the per-PR gate stays chromium-only).

## [0.14.2] - 2026-07-10

### Fixed

- SMS verification now returns a clear service-unavailable response when delivery is disabled or rejected instead of falsely reporting that a code was sent.
- Failed verification deliveries remove their unusable pending code, and SMS dry-run logs no longer expose phone numbers or one-time codes.
- Wired the root Terraform SMS gate through to the API module so production configuration can enable delivery after AWS approves SMS production access and origination registration.

## [0.14.1] - 2026-07-10

### Fixed

- Completed tasks now remain visibly completed while server state converges, with the action protected against duplicate submissions.
- Settings deep links now open the requested section, including `/settings/billing`, and tab navigation works with arrow, Home, and End keys.
- Failed plant-photo uploads can retry the same file, and clipboard actions now report failures instead of silently claiming success.
- Removed mobile overflow and cramped controls across task, plant, household, settings, chat, dialog, and toast interfaces, including the 320 px viewport.

### Changed

- Reworked frontend layouts mobile-first with consistent full-width actions, safe-area handling, minimum touch targets, responsive dialogs, and accessible status and error announcements.
- Expanded browser coverage across Chromium, Firefox, and WebKit, responsive viewport states, authenticated routes, dialogs, keyboard interactions, and WCAG scans.

## [0.14.0] - 2026-07-10

### Fixed

- Completing a task now updates the UI immediately and can no longer be visually undone by an eventually consistent list refresh.
- Downscale photos client-side before the "Identify from photo" upload, closing the iPhone leaf-health upload size-mismatch class of bugs.

### Added

- New plants can automatically receive a visible, editable care-task bundle based on their species, with an opt-out before saving.
- README `## Standards conformance` table declaring applicability/state for all 11 vendored standards (DOC-11/12/13).
- `docs/RESPONSIBLE-TECH-AUDITS.md`: ASVS level, RTF §A–F applicability, SEC-40 §F declarations, and the dated AI-EVALUATION-STANDARD waiver (AIEV-01).
- `evals/` — starter AI-evaluation harness for the Bedrock plant-care chat: a corpus-grounded benchmark set, a citation/grounding guard with unit tests, and a committed `eval-baseline.json` wired into a new CI job (AIEV-02, AIEV-12, AIEV-26).
- `model-card.md`, `docs/audits/ai-risk-register.md`, `docs/audits/eu-ai-act-classification.md` (RTF-05/09/12, AIEV-22).
- `.github/CODEOWNERS`, `.nvmrc`, ADR-0005 (npm-workspaces monorepo), ADR-0006 (standards applicability declarations).
- `npm run verify` — chains format:check → lint → typecheck → test → audit gate → bare-marker grep, mirroring CI stages 1–5 (CICD-27).

### Changed

- CI: Node 20 → 22 (LTS) across all three workflows + `.nvmrc` + `engines.node`.
- CI: `gitleaks` pinned version 8.21.2 → 8.30.1.
- CI: Lighthouse gate no longer skippable via a human-applied `skip-lighthouse` PR label — it now runs automatically based on whether the diff touches `frontend/**`, closing the OBS-23/24/25 + A11Y-02 bypass.
- `cd-staging.yml`: removed `continue-on-error: true` from the staging E2E step so a real failure is no longer silenced.
- All three `package.json` versions bumped from the stale `0.1.0` to the actual shipped version, `0.13.1`, matching the `v0.13.1` git tag (REL-02/REL-03).
- `docs/security.md` A06 and `docs/accessibility.md` corrected to stop overstating current enforcement (Renovate/Dependabot are configured, not "recommended next step"; the axe e2e gate enforces WCAG AA, not an AAA slice).

### Security

- Added a `gitleaks protect --staged` pre-commit hook (Gate 1) alongside the existing CI gitleaks run (Gate 2).
- Public-API keys are now hashed with scrypt (memory-hard) instead of unsalted SHA-256 for the `GSI3` lookup index. The hash stays deterministic (a fixed application salt) so lookup remains a single point read; a per-hash random salt was ruled out because it would break lookup-by-key. Closes CodeQL `js/insufficient-password-hash`. **Breaking for the public API:** any API key issued before this change no longer resolves and must be re-created under Settings → API keys (pre-launch; no plaintext is stored, so old hashes cannot be migrated).
- The post-deploy smoke test now derives its throwaway account email from `crypto.randomUUID()` rather than `Math.random()`, so a mid-run account name is no longer predictable/squattable. Closes CodeQL `js/insecure-randomness`.

## [0.13.1] - 2026-07-05

### Fixed

- Photo-upload size mismatch affecting iPhone leaf-health uploads, plus five other deferred bugs found in the same sweep (#174).

## [0.13.0] - 2026-07-05

Tag cut prior to this changelog's introduction — see `git log v0.12.3..v0.13.0` for the full commit list.

## [0.12.3] - 2026-07-05

### Fixed

- Geocode space-separated "city country/state" climate queries (#172).

## [0.12.2] - 2026-07-04

### Fixed

- Swept the Perenual integration for the remaining missing-data-reported-as-a-false-answer bugs (#171).

## [0.12.1] - 2026-07-04

### Fixed

- Stop claiming "no watering needed" when Perenual species data is simply missing (#170).

## [0.12.0] - 2026-07-04

### Added

- Unified the whole app on the garden-journal design system (#168).

### Fixed

- Removed members are locked out only on member-scoped routes, plant reactivation is cap-checked with stale seedling member counts corrected, and "asparagus fern" no longer gets a false non-toxic verdict (#163, #164, #165).

### Changed

- Landed 8 verified major dependency upgrades (Vite 8 among them); the Tailwind 4 and Express 5 bumps were held and reverted to keep `npm ci` green on main (#167, #169).
- Lambdas moved to arm64 and a bare-marker CI gate was added (#166).

## [0.11.1] - 2026-06-21

### Added

- Vendored the portfolio standards into `docs/standards/` and hardened the CI workflows (#137).

### Fixed

- Dead-domain canonicals/sitemap corrected and repo findability metadata enriched (#138).

## [0.11.0] - 2026-06-21

### Added

- Chat turn idempotency and atomic budget reservation (#136).

## [0.10.0] - 2026-06-21

### Fixed

- Chat billing records partial usage on failure, persists tool pairs atomically, and aborts abandoned streams (#135).
- The last-admin guard is atomic against concurrent demote/remove, and admin UI is gated on the active household's role rather than the claim default (#130, #131).
- Confirm-email routes to sign-in and preserves the invite redirect (#134).
- The weekly digest claims its send slot only after a real send (#132).

## [0.9.0] - 2026-06-21

### Fixed

- A reminder is counted delivered only on a real send (#124).
- Tokens refresh after joining a household so the new household claim applies (#129).
- Chat messages are ordered by an atomic per-conversation sequence (#128).
- Billing resolves the plan from the live price and gates conversion on dedup (#125).

## [0.8.0] - 2026-06-21

### Added

- Annual plans (Garden $39.99/yr, Greenhouse $79.99/yr) and a one-time lifetime Garden plan, with server-confirmed `subscription_activated` analytics carrying a household group key (#109, #112, #113, #116).
- An honest notice when a species has no care data (#110).

### Security

- Hardened the mail forwarder, rate-limited the chat stream, tightened IAM/PITR/MFA, and patched the js-yaml DoS advisory via an npm override (#108, #118).

## [0.7.0] - 2026-06-17

### Added

- No-account, time-boxed sitter links so a plant sitter can check off tasks (#100).
- A free pet-safe plant checker page, a shareable cutting card, and six new care guides plus two blog posts (#96, #99, #101).
- Welcome email and first-plant activation polish (#102).

### Fixed

- Per-function, DynamoDB, and api-5xx alarms treat missing data as not-breaching (#94).

## [0.6.0] - 2026-06-16

### Added

- The free plan now covers the whole household, up to 6 members (#93).
- A heads-up when adding a plant that's toxic to pets (#91).
- Warmer reminder copy and a welcome for solo plant-keepers (#92).

## [0.5.0] - 2026-06-16

### Fixed

- Code-review remediations across backend, frontend, and infrastructure: DND reminders, activity pagination, assignee validation, overdue scoping, gated prod apply, deploy-role deny, and more (#87, #88, #90).

### Changed

- React 18 → 19 (#86).

## [0.4.0] - 2026-06-16

### Added

- The landing page now sells the full range of personas and capabilities (#82).

### Fixed

- The differentiators band uses a real list, not a definition list (#85).

### Changed

- Repo prepped for public release; Dependabot alerts cleared for vitest, vite, esbuild, and uuid (#83).

## [0.3.0] - 2026-06-12

### Added

- Frontend design overhaul: asymmetric hero, botanical icons, humanized copy, responsive fixes, de-genericized UI (#63, #65).

### Fixed

- CD captures the published Lambda versions for rollback instead of the `latest` alias (#60).

## [0.2.0] - 2026-06-11

First tagged release: the initial React + Lambda/DynamoDB/Cognito app plus the hardening sweep that made it deployable — CI/CD OIDC deploys with archived-zip rollback, blocking gitleaks + Semgrep + Dependabot, DLQs and audit alarms, incident/runbook/compliance docs, plant lifecycle states, and ELv2 licensing with inbound mail forwarding (see `git log v0.2.0` for the full list).
