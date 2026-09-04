# Notifications

Three channels (browser, email, SMS), each individually opt-in per user, all flowing through one entry point so adding a fourth channel later is small.

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
dndStart, dndEnd, timezone, pestAlerts, weeklyDigest, updatedAt
```

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

## Sending arbitrary notifications

Code outside the reminder loop can call `notifier.sendToUser(recipient, payload)` to deliver any notification. Today the only caller is `runReminders`. Future callers (member-added, task-assigned, plant-shared) should use the same entry point so prefs are honoured.

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
