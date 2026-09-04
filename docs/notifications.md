# Notifications

Three channels (browser, email, SMS), each individually opt-in per user, all flowing through one entry point so adding a fourth channel later is small.

Two families of message ride those channels:

- **Reminders and summaries** — "your plants need care". Per-member, plant-shaped, described below.
- **[Household emails](#household-emails)** — "the people you share care with did
  something". Email only, event-driven, and each individually switchable.

## How a reminder gets delivered

```
EventBridge cron (hourly)
        │
        ▼
Lambda runReminders
        │
        ▼
For each member of the household:
  1. Read prefs from DDB (USER#{id} / PREFS)
  2. Roll up their assigned + unassigned tasks due in the next 24h
  3. Compose one payload {title, body, shortBody, url, tag}
     via services/reminderEmail.composeReminderEmail
  4. Reserve each eligible channel's daily delivery marker
  5. notifier.sendToUser(recipient, payload, {channels})
        │
        ├─▶ if prefs.browser → web-push to all stored PushSubscriptions
        ├─▶ if prefs.email   → SES SendEmailCommand
        └─▶ if prefs.sms && prefs.phone → SNS Publish
```

## What the reminder actually says

`services/reminderEmail.ts` holds the copy and layout; `services/reminders.ts`
holds delivery. The composer is pure — no DynamoDB, no environment — which is
what makes the rules below testable
(`backend/tests/unit/services/reminderEmail.test.ts`).

A rendered example, for a member with nine due rows, one of them unclaimed, who
is covering for someone on holiday:

```
Subject: Plant care reminder: 3 overdue, 1 due today and 5 coming up,
         including 1 nobody has claimed

Here is where your household's plant care stands: 3 overdue, 1 due today and
5 coming up, including 1 nobody has claimed.

Yours, most urgent first:

1. Monstera — water, 6 days overdue
   https://familygreenhouse.net/plants/8f3c…
2. Fiddle Leaf Fig — fertilize, 2 days overdue
   https://familygreenhouse.net/plants/1a22…
…

Showing 6 of 8. The full list is linked at the end of this email.

Up for grabs — nobody has claimed these, so anyone can:

- Snake Plant — repot, 3 days overdue
  https://familygreenhouse.net/plants/77bd…

You're covering for Sam, who is away until 9 June 2026.

Rain is forecast for your area — outdoor plants likely don't need watering
today.

Open any plant above to log the care, or see everything here:

https://familygreenhouse.net/tasks?filter=due
```

The rules the composer enforces:

- **Every row is named and deep-linked** to its own plant (`/plants/{id}`), not
  to the filtered list. The list link is the footer only.
- **A capped list always states the true total.** `rows` is the member's
  complete set; `MAX_LISTED_ASSIGNED` / `MAX_LISTED_UNCLAIMED` cap the display
  and the counts stay real. Same rule, and the same reason, as
  `digest.composeDigestEmail`: under-reporting reassures precisely the
  households that most need the nudge.
- **Zero is never printed as information.** The old body read `5 ready for some
catch-up care, 0 coming up soon`; empty buckets are simply omitted.
- **Unassigned tasks are shown as claimable**, in their own section, instead of
  being folded into an anonymous integer mailed to every member.
- **A failed read is never rendered as a value.** A member row that will not
  load yields "a household member whose name we couldn't load", never a person
  called "a housemate"; an unparseable `nextDue` yields "due date could not be
  read", never `NaN days`; a custom task with no `customType` yields "unnamed
  care task", never the literal `custom`.
- **Both locales.** `reminderEmail` carries complete `en` and `es` catalogs.
  Nothing in the backend stores a user language yet, so `reminders.ts` passes
  `'en'` from a single constant (`REMINDER_LOCALE_ADOPTION`) that becomes a
  read of that field when it lands.

### Weather

The reminder reads the household's cached forecast and adds a rain or frost
line when one applies — a watering reminder on a rain day is exactly the case
`climate.deriveClimateTips` exists for. The read happens at most once per
household per run, and only when a member is actually being composed a
reminder, so the daily dedupe marker keeps it to roughly one forecast read per
household per day.

If the forecast cannot be read — the Lambda has no `OPENWEATHER_API_KEY`, the
household has no saved location, the provider is down — the email says nothing
about the weather. It never says "no rain expected", which would be a claim
derived from a failed read.

`OPENWEATHER_API_KEY` reaches the `reminders` Lambda through
`local.weather_environment` in `infrastructure/modules/api/main.tf`. Until that
is applied the reminder simply omits the line.

### `shortBody`

SMS is capped at one 140-byte segment and a push body shows two or three lines,
so the payload carries a `shortBody` — the counts sentence on its own. Email
gets the full list; SMS and browser push get `shortBody`. Callers that omit it
are unchanged: `body` is used everywhere.

### Accepted is not delivered

A finalized reminder marker records that **a provider accepted** the
notification. `emailNotifier.sendEmail` returns `true` the moment SES resolves
`SendEmailCommand`; there is no SES configuration set, bounce destination or
suppression list, so a hard bounce still finalizes the day's marker as `sent`.
Nothing in the reminder path may treat `status: 'sent'` as evidence of receipt.
Closing that gap (bounce/complaint handling and suppression) is deliberately
outside this path.

Failures in one channel never block the others — each call is wrapped in a
per-channel try/catch that logs the failure and lets the other dispatches
continue. A provider-accepted channel finalizes only its own daily marker; a
failed channel releases its lease for the next hourly retry. During DND,
browser push remains eligible (the OS manages quiet hours) while email and SMS
remain unmarked and are retried after the window ends.

## User-facing surface

`Settings → Notifications` lets each user choose:

- **Browser**: a single button that requests `Notification.permission` and registers a service-worker push subscription if VAPID is configured. The user's browser-permission state is captured + reflected (granted / denied / default).
- **Email**: a checkbox. Defaults to **on** because we already have the user's email from Cognito; nothing extra needed.
- **SMS**: a checkbox + phone-number input. The number must be E.164 (`+15551234567`); the form validates client-side and the backend re-validates. Disabling SMS keeps the verified number so re-enabling it does not force another verification; changing or clearing the number clears verification.

The dashboard also fires lightweight in-tab `Notification` pop-ups when a previously-fresh task slips into overdue while the user is on the page — see `frontend/src/hooks/useOverdueAlerts.ts`. These don't require web-push and work even without VAPID.

## Storage

### Notification preferences

Stored under the user partition with `SK = "PREFS"`:

```
PK: USER#{userId}
SK: PREFS
entityType: NotificationPreferences
userId, browser, email, sms, phone, phoneVerified,
dndStart, dndEnd, timezone, pestAlerts, weeklyDigest,
memberJoined, taskUpForGrabs, coverageUpdates, careCredit, updatedAt
```

The last four are the household-email switches. Like `weeklyDigest`, they are
optional in the PUT body and default-on at read time _only when `email` is on_,
so a row written before they existed is not silently opted into new mail it
never accepted, and an older client that omits them keeps the stored value
instead of resetting it.

One row per user. Read on every reminder fan-out; written when the user saves the settings page.

### Push subscriptions

Stored under the user partition with one row per device:

```
PK: USER#{userId}
SK: PUSH#{endpointHash}
entityType: PushSubscription
userId, householdId, endpoint, keys: { p256dh, auth }, createdAt
```

Endpoint hash is the first 64 bits of SHA-256. The point is to dedupe per
device without putting a long provider URL in the sort key. When the browser
drops a subscription (404/410 from web-push), the notifier deletes the row.

### Reminder channel markers

Each accepted reminder channel is stored independently:

```
PK: USER#{userId}
SK: REMINDED#{localDate}#HOUSEHOLD#{householdId}#CHANNEL#{browser|email|sms}
entityType: ReminderMarker
channel, status, sentAt, ttl
```

Before a provider call, the row is conditionally written with
`status = "sending"`, a five-minute lease, and a reservation ID. Success
finalizes that channel; failure deletes only that reservation. This prevents
overlapping manual/scheduled runs from duplicating a channel while allowing
failed or DND-deferred siblings to retry. Older aggregate marker shapes remain
authoritative until their TTL expires, so rolling deployment does not resend a
reminder on deploy day.

The same hourly Lambda then runs `runHouseholdEmails`, which offers up any
long-overdue unassigned tasks and delivers each member's queued household
emails. It is wrapped so a failure there cannot take down the reminder pass, and
vice versa.

## Channel-by-channel details

### Browser pop-ups (no infra)

Pure client-side. `frontend/src/utils/notifications.ts` is a thin wrapper around the `Notification` API plus a localStorage flag remembering the user's "I want this" choice. `useOverdueAlerts` watches the upcoming-tasks query and fires once per task as it crosses the overdue line.

No env vars. Works offline.

### Web push (VAPID)

Generate a VAPID keypair once per environment:

```bash
npx web-push generate-vapid-keys
# Public Key:  BPp7...
# Private Key: KS9q...
```

Set:

- Backend: `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT` (mailto: address that vendors can contact)
- Frontend: `VITE_VAPID_PUBLIC_KEY` (same value as backend public key)

The generated Workbox service worker imports the checked-in
`frontend/public/push-handler.js`. It displays the server payload in the
background, opens same-origin deep links on click, and rejects cross-origin
notification URLs. The worker and push handler are deployed with `no-cache`
headers so browsers see handler fixes promptly.

Without these env vars, `notifier.sendBrowserPush` logs a `push_dry_run` line and returns — the rest of the fan-out is unaffected.

### Email (SES)

Set `SES_FROM_EMAIL` to a verified SES identity. The Lambda role needs `ses:SendEmail` on that identity (or the wildcard for all).

Out of the SES sandbox, you can send to anyone. In sandbox mode, the recipient address must also be verified — fine for staging, fatal for production. File a support case to get out of sandbox before launch.

The reminder body is a multi-line list; see "What the reminder actually says"
above for the layout and the rules it holds. The digest, recap and welcome
emails compose their own bodies.

We send plain-text only. No HTML. Reasons:

- Templating overhead is not worth it for a household app
- Plain-text avoids a class of phishing-look-alike risk
- Email clients render it fine

Without `SES_FROM_EMAIL`, the notifier logs an `email_dry_run` line and returns.

`SES_FROM_EMAIL` reaches the `households`, `notifications`, `reminders`,
`digests`, `billing` and `me` Lambdas (`infrastructure/modules/api/main.tf`).
The last two were added for the billing-lifecycle emails
([ADR 0023](adr/0023-billing-lifecycle-emails.md)); without it every receipt,
renewal notice and account-deletion confirmation is a dry-run log line.

#### Transactional email is not governed by these preferences

Everything on this page — reminders, digest, recap, pest alerts — is gated on
`notificationPrefs` and the do-not-disturb window. The billing emails
([`docs/billing.md`](billing.md#billing-emails)) deliberately are **not**: a
person who turned off plant reminders has not agreed to be charged silently,
and a quiet hour is not a reason to delay telling someone their card failed.
They read `notificationPrefs` for the `timezone` field only, and they carry no
unsubscribe link — instead a footer states that they are billing messages and
why there is no unsubscribe. The welcome email is the third member of this
group: it also ignores preferences, by design.

### SMS (SNS)

SMS is paid. SNS direct-publish to a phone number costs ~$0.0075 per US message and varies internationally. To prevent accidental cost from a misconfigured staging stack, we require an explicit `SMS_NOTIFICATIONS_ENABLED=1` environment flag on top of the AWS credentials.

Phone numbers are stored in E.164 (e.g. `+15551234567`). The frontend, the schema, and the SNS adapter all validate this independently. SMS bodies are truncated to 140 bytes (one segment); we don't pay for multi-segment messages today.

We mark messages as `Transactional` (vs `Promotional`) — this gets you better delivery rates, slightly higher per-message cost, and is the legally appropriate choice for "your plant needs water." Marketing messages would be Promotional, which we don't send.

#### Sandbox + verification

In SNS sandbox mode (default for new accounts), you can only send to verified phone numbers. To get out of sandbox you fill in a use-case form in the SNS console; AWS approves on the order of a day. Until then your test recipients need to verify themselves via the console.

Production must also set `sms_notifications_enabled = "1"` in the root
Terraform environment after sandbox exit and origination registration. The
phone-verification endpoint returns 503 while the flag is off or SNS rejects
delivery; it never reports a code as sent unless SNS accepted the publish.

#### Phone-number verification

Users enter an E.164 number, receive a six-digit one-time code, and confirm it
before SMS can be enabled. Codes expire after ten minutes, are stored only as
hashes, and lock after five incorrect attempts. Changing the number clears its
verified state.

## Household emails

`services/householdEmails.ts` + `services/inviteEmail.ts`, with all copy in
`services/emailCopy.ts`.

Every other email in the product is addressed to one person about their plants.
These are about the household as a group of people, which is the thing
`docs/roadmap.md` measures (_"active members per household ≥1.5"_) and the thing
`docs/strategy-review.md` calls the moat.

| Email                       | Trigger                                         | Audience                | Deep links                                       | Pref                          | Cap                                  |
| --------------------------- | ----------------------------------------------- | ----------------------- | ------------------------------------------------ | ----------------------------- | ------------------------------------ |
| **Invite**                  | `POST /households/{id}/invites/email` (admin)   | one address, no account | the join link                                    | n/a — recipient is not a user | 10/household/day + 1/address/day     |
| **Someone joined**          | a successful `POST /households/join/{code}`     | every existing member   | `/household`                                     | `memberJoined`                | once per join                        |
| **Up for grabs**            | hourly scan: unclaimed, due in (24h, 7d]        | every member            | `/plants/{id}` per task, `/tasks?filter=overdue` | `taskUpForGrabs`              | 1/household/ISO week                 |
| **You're covering**         | `PUT /tasks/vacation`                           | the named cover         | `/plants/{id}` per task, `/tasks`                | `coverageUpdates`             | once per window (keyed on its dates) |
| **Someone covered for you** | a completion by someone other than the assignee | the assignee only       | `/plants/{id}` per task, `/dashboard`            | `careCredit`                  | 1/recipient-local day, rolled up     |

### Why the invite email is the important one

`householdService.createInvite` has minted a 128-bit code with a 7-day TTL since
May 2026 and the product could never send one — invites were copy-and-paste
only, so `invite_sent → invite_accepted` (the loop `docs/analytics.md` names as
unmeasurable) had no email step at all.

Because it mails an address the service has never seen, it is bounded on four
sides: admin-only, a per-household daily cap enforced by a conditional counter
(not a read-then-write), one email per address per household per day, and a
per-user route limit. There is no free-text field an inviter can fill — prose we
send on someone's behalf to a person who has not consented to hear from them is
how an invite feature becomes an open relay. An invite that cannot name its
sender **and** its household is not sent at all; the endpoint answers 503 and the
UI falls back to the copyable link.

The response always carries the link and a `status` (`accepted` /`unavailable` /
`identity_unavailable` / `recipient_cooldown`). `accepted` means SES took the
message — which is not delivery, since there is no bounce destination wired yet
— and the field is named for what we actually know.

### Why "up for grabs" only looks forward

The daily reminder queries `nextDue <= now + 24h`, which includes everything
already overdue, and [#427](https://github.com/ChelseaKR/family-greenhouse/pull/427)
gives that email its own "Up for grabs" section for the unclaimed rows in it. A
dedicated email about unclaimed _overdue_ tasks would therefore name the same
task twice on the same morning, to every member.

So the two are **disjoint by construction**, which is the split #427 proposed:
the reminder owns everything at or inside its 24-hour window, and this email
owns `(24h, 7d]` — the unclaimed work nobody is being told about at all.
`REMINDER_DUE_WINDOW_MS` in `services/householdEmails.ts` is the only place the
line is encoded, and there is no shared state between the two paths.

It is also the better half to own. Asking for a hand _before_ anything is late
is the anti-nag version of the ask; asking after is the nag.

The cadence is one per recipient per ISO week, not per day, because this is the
only household email whose trigger is a standing state rather than an event — a
forward list of unclaimed work barely changes overnight, so a daily cadence
would be the same email again. The lookahead equals the cadence on purpose, so
nothing falls between the two surfaces: a task further out is caught by a later
weekly pass while still unclaimed, and one that crosses inside 24 hours first is
caught by the daily reminder that morning.

**If #427 does not land**, unclaimed overdue tasks stay an anonymous integer in
the reminder and no email names them. The fix is one constant
(`REMINDER_DUE_WINDOW_MS` → `0`), not a redesign.

### Why "someone covered for you" is not a leaderboard

It fires only when a task **had** an assignee and somebody else completed it, and
it goes only to that assignee. It carries no per-person counts, no ordering by
volume, no mention of the recipient's own contribution, and no mention of anyone
who did less. Chore apps do monetize contribution scoreboards (Tody's FairShare,
Sweepy's family leaderboard), but a floor left uncleaned is an annoyance and a
plant left unwatered dies, and ranking is the mechanism by which a chore app
nags. Broadcasting "Sam watered the Monstera" to the whole household was the
obvious alternative and is deliberately not built: to most recipients it is a
stranger's chore, and to the rest it is the digest's bystander problem with a
friendlier subject line.

### The queue

Three of the four fire on a one-shot event, and a one-shot send has nowhere to
retry and no way to respect a quiet window. So each is written to a row first and
delivered by `flushUser`, which the hourly reminder Lambda already calls per
member:

```
PK: USER#{userId}
SK: HHEMAIL#{dedupeKey}
entityType: HouseholdEmailQueueItem
kind, householdId, email, items (list of JSON payload fragments),
overflow, status: pending|sent, createdAt, expiresAt, ttl
```

- **DND** — a row whose owner is inside their quiet window is left alone and
  picked up by a later hourly pass.
- **Retry** — an SES exception or a dry run (`sendEmail` returning `false`) leaves
  the row `pending`.
- **Dedupe** — the sort key _is_ the marker, and a delivered row is kept as `sent`
  until TTL rather than deleted, so a repeated trigger cannot produce a second
  email. Daily keys use the **recipient's** local date, not the server's; the
  weekly `up_for_grabs` key is UTC-based, so a member who travels cannot collect
  two copies of one week.
- **Roll-up** — `care_credit` appends, so ten covered tasks in an afternoon
  produce one email. Past the list cap the surplus becomes an `overflow` count
  the email states truthfully.
- **Staleness** — a row undelivered after 36 hours is dropped with a
  `household_email.expired` log line rather than sent as stale news.

Preferences are re-read at send time, not trusted from enqueue time, so a user
who switches an email off never receives one already queued.

### Honest failure

`docs/adr/0010-settled-read-states.md` applies to the copy, not just the data:

- A member row that could not be read yields `null`, and the copy says the name
  is missing with a link to the surface that has it. It never becomes a person
  called _"a housemate"_ (`reminders.ts`) or a plant called _"A former plant"_
  (the recap in `digest.ts`).
- A coverage email's task list is `null` when the read did not settle and `[]`
  when it settled and there is genuinely nothing. Those are different sentences.
- A household with unassigned overdue tasks but an empty active-plant read is
  reported as `unknown`, never as "nothing to do" — the hole in
  `computePlantsAtRisk`, where a non-throwing short read makes a broken week and
  a healthy week identical.
- `runHouseholdEmails` returns `unknown` and `failed` alongside `sent`, and the
  reminder Lambda reports `householdEmails: null` when the whole pass throws, so
  a broken hour can never be read as a calm one.

### Localization

These are the first emails in the product written in both languages. The i18n
system is frontend-only, so `services/emailCopy.ts` carries its own EN/ES
catalog: per-language plural forms rather than the `total === 1 ? 'plant' :
'plants'` ternaries the digest bakes into logic, and `Intl` for every date and
number, which `docs/i18n.md` requires and the older composers violate (the
i18n gate only scans `frontend/`).

The invite email takes its language from the request, because the invitee has no
account and therefore no stored preference — the inviter's UI locale is the best
signal available. The other four call `preferredEmailLocale(prefs)`, which reads
a `locale` field on the preferences row if one is present and otherwise returns
English. That field is being added on a parallel branch; when it lands these
switch language with no change here.

### Unsubscribe

Every household email ends with a link to `/settings`. A real
`List-Unsubscribe` header needs `emailNotifier.sendEmail` to move to the SES v2
API, which is out of scope here.

## Sending arbitrary notifications

Code outside the reminder loop can call `notifier.sendToUser(recipient, payload)` to deliver any notification. Today the only caller is `runReminders`. Household emails deliberately do not use it: they are email-only by nature and should not be rerouted to SMS or suppressed by a window aimed at real-time pings — they defer inside it instead.

A payload whose `body` runs to more than a couple of lines should also set
`shortBody`; SMS and browser push use it, email does not.

## Local development

All channels degrade to structured `pino` log lines when their env vars aren't set:

```
{"level":"info","msg":"email_dry_run","to":"alice@example.com","subject":"Plant care reminder"}
{"level":"info","msg":"sms_dry_run"}
{"level":"info","msg":"push_dry_run","userId":"user-1","count":2,"payload":{...}}
```

The local Express server's `POST /notifications/run-reminders` does the same
dry-run with `console.log` so you can observe recipient routing without AWS or
VAPID setup. It returns
`{ "sent": 0, "simulated": N, "simulatedByChannel": { "browser": B, "email": E, "sms": S } }`.
`sent` is deliberately zero because no provider accepted a message. The local
dedupe markers are channel-scoped too, so adding a missing push subscription
retries push without simulating email twice. To trigger it manually:

```bash
curl -X POST http://localhost:4000/notifications/run-reminders \
  -H "Authorization: Bearer mock-token-550e8400-e29b-41d4-a716-446655440000-1"
```

## Testing

- Unit tests for the prefs model, each notifier, and the fan-out logic in `notifier.ts`
- `services/reminderEmail.test.ts` covers the reminder copy in both locales:
  list rendering, the capped-subset-with-true-total rule, each honesty rule,
  the vacation-cover path and the climate lines
- `services/remindersContent.test.ts` runs the same rules end to end through
  `remindHousehold`, including the once-per-run forecast read and a cross-check
  that the reminder's rain/frost predicates agree with
  `climate.deriveClimateTips`
- Integration tests against the local server cover prefs CRUD and simulated
  recipient routing; they do not claim provider receipt
- The notifier's per-channel error paths are unit-tested by mocking SES/SNS/web-push to throw and asserting the other channels still execute
- Household emails have unit tests per trigger, per preference gate, for both
  rate limits on the invite path, and for every honest-failure path (unreadable
  name, unreadable task list, empty active-plant read, dry run, provider
  exception, stale row). Copy is asserted in both languages
