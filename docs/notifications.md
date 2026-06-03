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
  2. Look up their assigned tasks due in the next 24h
  3. Compose one payload {title, body, url, tag}
  4. notifier.sendToUser(recipient, payload)
        │
        ├─▶ if prefs.browser → web-push to all stored PushSubscriptions
        ├─▶ if prefs.email   → SES SendEmailCommand
        └─▶ if prefs.sms && prefs.phone → SNS Publish
```

Failures in one channel never block the others — each call is wrapped in a per-channel try/catch that logs the failure and lets the other dispatches continue.

## User-facing surface

`Settings → Notifications` lets each user choose:

- **Browser**: a single button that requests `Notification.permission` and registers a service-worker push subscription if VAPID is configured. The user's browser-permission state is captured + reflected (granted / denied / default).
- **Email**: a checkbox. Defaults to **on** because we already have the user's email from Cognito; nothing extra needed.
- **SMS**: a checkbox + phone-number input. The number must be E.164 (`+15551234567`); the form validates client-side and the backend re-validates. Disabling SMS also clears the stored phone number from DDB.

The dashboard also fires lightweight in-tab `Notification` pop-ups when a previously-fresh task slips into overdue while the user is on the page — see `frontend/src/hooks/useOverdueAlerts.ts`. These don't require web-push and work even without VAPID.

## Storage

### Notification preferences

Stored under the user partition with `SK = "PREFS"`:

```
PK: USER#{userId}
SK: PREFS
entityType: NotificationPreferences
userId, browser, email, sms, phone, updatedAt
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

Endpoint hash is a small djb2-style string hash. The point is to dedupe per device so re-registering doesn't duplicate. When the browser drops a subscription (404/410 from web-push), the notifier deletes the row.

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

The frontend service-worker (provided by `vite-plugin-pwa`) needs to register a `push` event handler that displays the message. Add to `frontend/public/sw.js` if you want richer UX than the default.

Without these env vars, `notifier.sendBrowserPush` logs a `push_dry_run` line and returns — the rest of the fan-out is unaffected.

### Email (SES)

Set `SES_FROM_EMAIL` to a verified SES identity. The Lambda role needs `ses:SendEmail` on that identity (or the wildcard for all).

Out of the SES sandbox, you can send to anyone. In sandbox mode, the recipient address must also be verified — fine for staging, fatal for production. File a support case to get out of sandbox before launch.

We send plain-text only. No HTML. Reasons:

- Templating overhead is not worth it for a household app
- Plain-text avoids a class of phishing-look-alike risk
- Email clients render it fine

Without `SES_FROM_EMAIL`, the notifier logs an `email_dry_run` line and returns.

### SMS (SNS)

SMS is paid. SNS direct-publish to a phone number costs ~$0.0075 per US message and varies internationally. To prevent accidental cost from a misconfigured staging stack, we require an explicit `SMS_NOTIFICATIONS_ENABLED=1` environment flag on top of the AWS credentials.

Phone numbers are stored in E.164 (e.g. `+15551234567`). The frontend, the schema, and the SNS adapter all validate this independently. SMS bodies are truncated to 140 bytes (one segment); we don't pay for multi-segment messages today.

We mark messages as `Transactional` (vs `Promotional`) — this gets you better delivery rates, slightly higher per-message cost, and is the legally appropriate choice for "your plant needs water." Marketing messages would be Promotional, which we don't send.

#### Sandbox + verification

In SNS sandbox mode (default for new accounts), you can only send to verified phone numbers. To get out of sandbox you fill in a use-case form in the SNS console; AWS approves on the order of a day. Until then your test recipients need to verify themselves via the console.

#### Phone-number verification (TODO)

We don't currently send a verification code before enabling SMS for a new phone number. That's a real gap — a user could enter someone else's number and we'd happily send reminders to it. The right fix is to wire up a 2-step:

1. User enters phone, we send a confirmation code via SNS
2. User enters code, we mark the number verified and persist

It's a half-day's work; deferred until SMS gets actual usage. Tracked in [`production-checklist.md`](production-checklist.md).

## Sending arbitrary notifications

Code outside the reminder loop can call `notifier.sendToUser(recipient, payload)` to deliver any notification. Today the only caller is `runReminders`. Future callers (member-added, task-assigned, plant-shared) should use the same entry point so prefs are honoured.

## Local development

All channels degrade to structured `pino` log lines when their env vars aren't set:

```
{"level":"info","msg":"email_dry_run","to":"alice@example.com","subject":"Plant care reminder"}
{"level":"info","msg":"sms_dry_run","to":"+15551234567","body":"3 tasks due"}
{"level":"info","msg":"push_dry_run","userId":"user-1","count":2,"payload":{...}}
```

The local Express server's `POST /notifications/run-reminders` does the same dry-run with `console.log` so you can observe the fan-out shape end-to-end without any AWS or VAPID setup. To trigger it manually:

```bash
curl -X POST http://localhost:4000/notifications/run-reminders \
  -H "Authorization: Bearer mock-token-550e8400-e29b-41d4-a716-446655440000-1"
```

## Testing

- Unit tests for the prefs model, each notifier, and the fan-out logic in `notifier.ts`
- Integration tests against the local-server cover the prefs CRUD + the run-reminders fan-out
- The notifier's per-channel error paths are unit-tested by mocking SES/SNS/web-push to throw and asserting the other channels still execute
