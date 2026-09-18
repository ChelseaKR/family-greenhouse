# External services setup

How to wire each third-party integration that backs a Family Greenhouse feature. Everything here is **operator** work — pricing, accounts, console clicks — not code changes.

Pre-req: `aws sso login --profile family-greenhouse` (or whatever profile you use), and a working `terraform -chdir=infrastructure init`.

---

## Perenual — species autocomplete + care guides

**What we use it for:** `services/perenual.ts` powers `/species/search`, `/species/{id}`, `/species/{id}/guide`, the Add Plant species autocomplete, and the care suggestions on the plant detail page.

**Without it:** every call short-circuits to `null`. The autocomplete is empty, plant cards show "Species unknown", care guide tab is blank. Nothing breaks; the feature just isn't there.

### Setup

1. Sign up at https://perenual.com/docs/api. The Hobby tier is free for 100 requests/day, which is plenty for low-traffic prod.
2. Copy your API key from the dashboard.
3. Store it as an SSM `SecureString`; only its parameter name belongs in
   Terraform:

   ```bash
   aws ssm put-parameter \
     --name /family-greenhouse/perenual-api-key \
     --type SecureString \
     --value 'pe-XXXXXXXXXXXXXXXXXX' \
     --overwrite
   ```

4. Set `perenual_api_key_parameter_name =
"/family-greenhouse/perenual-api-key"` in the environment tfvars and apply.
   The species/reminder Lambdas receive only the parameter name and fetch the
   secret at cold start.
5. Verify: hit `GET /species/search?q=monstera` with a valid auth token; expect a JSON array of matches.

### Quotas + cost

- Free Hobby tier: 100 req/day, then 429.
- The service in code caches each species lookup in DDB for 7 days, so the request budget covers ~5–15 unique species per day per household.
- If you hit the cap, upgrade to Supreme ($5/mo, 5k req/day) — small.

---

## Plant.id — photo-based plant identification

**What we use it for:** `POST /plants/identify` — takes a base64 image and returns the top 3 species guesses.

**Without it:** the endpoint returns a demo response (a hard-coded "we'd need a real API key to identify this plant" suggestion). The Add Plant flow still works, just without photo identification.

### Setup

1. Sign up at https://web.plant.id/. The free tier is 100 identifications/month.
2. From the dashboard, copy your API key.
3. For automated deploys, add the key as the GitHub Actions secret
   `PRODUCTION_PLANT_ID_API_KEY` (and a separate
   `STAGING_PLANT_ID_API_KEY` if staging should call the provider). For a
   one-off local Terraform apply, pass it without committing it:

   ```bash
   export TF_VAR_plant_id_api_key='XXXXXXXXXXXXXXXXXXXXX'
   ```

4. `terraform apply`. Verify with the Add Plant → photo flow in the UI.

---

## OpenWeather — climate-aware care

**What we use it for:** household city lookup, current conditions, forecasts,
and rain/freeze/heat care suggestions.

**Without it:** climate endpoints return `configured: false`; saving a location
is unavailable and the dashboard suppresses weather tips.

### Setup

1. Create an OpenWeather API key.
2. Add it as `PRODUCTION_OPENWEATHER_API_KEY` in GitHub Actions secrets. Use
   `STAGING_OPENWEATHER_API_KEY` for an isolated staging key.
3. For a local Terraform apply, pass it only through the environment:

   ```bash
   export TF_VAR_openweather_api_key='...'
   ```

4. Deploy, save a household city, and verify that
   `GET /households/{id}/climate` returns `configured: true` with weather.

---

## Stripe — billing

**What we use it for:** `POST /billing/checkout` for plan upgrades, `POST /billing/webhook` for subscription state updates, `POST /billing/portal` for self-service management.

**Currently:** paid activity is disabled by the shared commercial-status hold,
`payments_enabled = "0"` in every environment, and blank production price IDs.
The paid-plan UI is built but renders the paused notice until the API reports
`paymentsAvailable: true`. `VITE_BETA_MODE` is presentation-only and is not a
commerce safety gate. Terraform preconditions fail the plan on a half-open or
under-configured gate. See `docs/COMMERCIAL-STATUS.md` for the ordered
reactivation runbook before changing any of these controls.

### Setup (test mode first)

1. Sign up at https://dashboard.stripe.com/.
2. **Stay in test mode** until you're done iterating. The toggle's in the top-right of the dashboard.
3. **Create products + prices**:
   - Products → Add product → "Garden" → recurring monthly → $4.99 → save. Copy the **Price ID** (`price_…`).
   - Same for "Greenhouse" at $9.99.
4. **Create a webhook**:
   - Developers → Webhooks → Add endpoint
   - URL: `https://<api-id>.execute-api.us-east-1.amazonaws.com/production/billing/webhook`
   - Events to send — **subscription state** (entitlement; the app is wrong without these):
     `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Events to send — **billing emails** (ADR 0023; the app is silent without these):
     `invoice.paid`, `invoice.upcoming`, `invoice.payment_failed`,
     `customer.source.expiring`
   - Events to send — **optional**: `checkout.session.expired`. Releases a
     household's hold on a second plan checkout at the 30-minute mark when it
     abandoned the first (`docs/billing.md` § _One plan checkout at a time_);
     without it the hold lifts on its own after 45 minutes. Nothing else reads
     it.
   - After creation, reveal + copy the **Signing secret** (`whsec_…`).
5. **API key**: Developers → API keys → copy the **Secret key** (`sk_test_…` for test mode).
6. tfvars:

   ```hcl
   stripe_secret_key          = "sk_test_..."
   stripe_webhook_secret      = "whsec_..."
   stripe_price_id_garden     = "price_..."
   stripe_price_id_greenhouse = "price_..."
   # Leave off until Stripe Tax registrations + product tax codes are configured.
   stripe_automatic_tax_enabled = ""
   ```

7. `terraform apply`. The billing Lambda env updates in place.
8. **Test from the dashboard's "Send test webhook"** — should appear in the billing Lambda's CloudWatch logs as a successful `applyStripeEvent` call (audit event `billing.subscription_changed`).

### Going live

When you're ready to actually charge:

1. Repeat steps 3–5 in Stripe **live mode** (different products + webhook URL + secrets).
2. Swap the tfvars to the live keys.
3. Complete the separately approved paid-hold exit in
   `docs/COMMERCIAL-STATUS.md`: update the dated status, wire the exact runtime
   gate, confirm live-mode prices, restore paid controls, and deploy through a
   reviewed non-production test first.
4. **Tax**: configure registrations in Stripe Tax, assign the appropriate SaaS tax code to each product, then set `stripe_automatic_tax_enabled = "1"`. Checkout will collect the minimum billing-address fields required and save refreshed addresses for returning customers. Do not flip this flag before the Stripe-side tax setup is complete.

### Checkout reliability and webhook checks

- The frontend sends a UUID for each checkout attempt. The API scopes it to the household and forwards it as Stripe's idempotency key, so transport retries return the original Checkout Session instead of creating another one.
- Keep the webhook event list above narrow. The async-payment event is required for a lifetime purchase that completes after `checkout.session.completed` initially reports `unpaid`.
- **The endpoint's event list is not Terraform-managed.** There is no Stripe
  provider in `infrastructure/` (only `hashicorp/aws` and `hashicorp/archive`),
  so subscribing an event is a Stripe dashboard action, and nothing in CI can
  detect that one is missing. What CI _can_ do is hold this list to the code:
  `backend/tests/unit/models/billingNotices.test.ts` fails if the notice model
  reads an event type this document does not name. Adding a billing email
  therefore means adding its event here, and then subscribing it in the
  dashboard by hand.
- The four **billing-email** events are optional for correctness and mandatory
  for the product: without `invoice.paid` no customer ever gets a receipt,
  without `invoice.payment_failed` a failing card churns silently, and the code
  cannot tell the difference between "not subscribed" and "nothing happened".
  Subscribe them in test mode first and confirm one of each arrives.
- `invoice.payment_succeeded` is deliberately **not** subscribed and is ignored
  by the code. Stripe emits it alongside `invoice.paid` for the same money, so
  subscribing both would send two receipts for one charge — two events, two
  ids, and a dedupe ledger that (correctly) cannot merge them.
- `customer.source.expiring` fires for Card/Source objects. Cards saved as
  PaymentMethods — which is what Checkout creates — do not reliably produce it,
  so the card-expiring email is a best-effort early warning and
  `invoice.payment_failed` remains the dependable dunning path. Do not describe
  it to customers as complete coverage.
- Stripe can deliver an event more than once and does not guarantee ordering. The app records processed event IDs and conditions household updates on Stripe's event timestamp; do not remove either guard.
- Before going live, complete one monthly, annual, and lifetime test checkout; replay a webhook from Stripe Workbench; and verify the household plan, customer ID, subscription ID, and period end in DynamoDB.

---

## SES — transactional email

**What we use it for:** Cognito-sent confirmation + password reset emails (now branded as `hello@familygreenhouse.net` via the SES domain identity), and reminder delivery via the EventBridge-invoked reminders Lambda.

**Current live status (verified 2026-07-25):** SES production access is granted
in `us-east-1`, sending is enabled and healthy, the
`familygreenhouse.net` identity is verified, and DKIM is successful. Cognito
uses that identity in `DEVELOPER` mode with public self-signup enabled.

Re-check before changing registration policy:

```bash
aws sesv2 get-account --region us-east-1
aws sesv2 get-email-identity \
  --email-identity familygreenhouse.net \
  --region us-east-1
```

---

## Sentry — error monitoring

**What we use it for:** Backend error reporting via `instrument()` wrapping each Lambda dispatcher; frontend error reporting via `frontend/src/sentry.ts` (already initialized when `VITE_SENTRY_DSN` is set).

### Setup

1. Sign up at https://sentry.io/, create a project for "Node.js (AWS Lambda)" and another for "React".
2. Copy each project's DSN.
3. Add the backend DSN as the GitHub Actions secret
   `PRODUCTION_BACKEND_SENTRY_DSN` and the React DSN as
   `PRODUCTION_FRONTEND_SENTRY_DSN` (use the corresponding `STAGING_*`
   secrets for staging). Set `PRODUCTION_SENTRY_TRACES_SAMPLE_RATE` to `0.1`.
   The deploy workflow passes the backend DSN through Terraform and bakes the
   frontend DSN into the Vite build.
4. The production CSP already permits Sentry ingestion. Deploy, then verify
   one controlled frontend exception and one Lambda exception in the two
   Sentry projects before relying on the rail for alerting.

### Verify

- Backend: throw a test error from a low-traffic endpoint and watch Sentry's issue list.
- Frontend: trigger an unhandled promise rejection in the browser console — should show up in the React project.

---

## Web Push (VAPID) — browser push notifications

**What we use it for:** Plant-care reminders delivered as browser push notifications. Without the keys set, the notifier dry-runs to logs (harmless).

### Setup

1. Generate a key pair (one-time, server-side keys you keep forever):

   ```bash
   npx web-push generate-vapid-keys
   ```

2. For a local/manual Terraform apply, export the three root variables (the
   private key should not be committed to a tfvars file):

   ```bash
   export TF_VAR_web_push_vapid_public_key="BAAAA..."
   export TF_VAR_web_push_vapid_private_key="AAAA..."
   export TF_VAR_web_push_vapid_subject="mailto:hello@familygreenhouse.net"
   ```

   In GitHub Actions, use the `PRODUCTION_WEB_PUSH_VAPID_*` or
   `STAGING_WEB_PUSH_VAPID_*` secret/variables documented in
   `docs/cicd-setup.md`. The workflows pass the private value only to
   Terraform and the matching public value to both Terraform and the frontend
   build.

3. `terraform apply`. The manual deploy script reads the public-key Terraform
   output into `VITE_VAPID_PUBLIC_KEY`; CI does the equivalent automatically.
   Configure all three values together or leave all three blank to keep push
   deliberately disabled.

---

## PostHog — product analytics

**What we use it for:** the conversion funnel — sign-up → confirm → activate →
hit a limit → open billing → checkout started → checkout completed — per real
household, without reading CloudFront logs by hand. `docs/analytics.md` is the
full design (what leaves the device, to whom, for how long, and how a visitor
opts out); this section is only the setup.

Two rails share one project key. The browser shim
(`frontend/src/services/analytics.ts`, a `fetch` POST to PostHog's capture
endpoint — no `posthog-js`, no cookie, no script) reads `VITE_POSTHOG_KEY` at
build time. The Stripe-webhook emitter (`backend/src/utils/serverAnalytics.ts`)
reads `POSTHOG_KEY` from the Lambda environment, which Terraform sets from the
same GitHub secret. That second rail is how "checkout completed"
(`subscription_activated`) reaches the same funnel as the browser steps.

### Setup

1. https://us.posthog.com/ → create an organization and a project on the
   **US cloud**. (The privacy page says events go to `us.i.posthog.com` and are
   stored in the United States. Choosing the EU cloud means changing that page
   and setting `PRODUCTION_POSTHOG_HOST` to `https://eu.i.posthog.com` — the
   CloudFront CSP already admits both.)
2. In the project: **Settings → Project → General → "IP data capture
   configuration"** → choose **discard**. Every event the shim sends already
   carries `$geoip_disable: true`, so PostHog derives no city or region from
   the request; this setting also stops the IP itself being stored on the
   event. The privacy page promises both.
3. Leave session replay, autocapture, heatmaps and surveys off. None of them
   can activate — there is no SDK in the page to run them — but the project
   settings should say what the code does.
4. Copy the **project API key** (`phc_…`). It is a write-only key by design
   and ships inside the public bundle; that is normal for PostHog.
5. In a terminal, never through an agent session:

   ```bash
   gh secret set PRODUCTION_POSTHOG_KEY --repo ChelseaKR/family-greenhouse
   ```

   as a **repository** secret. The `build` job in `cd-production.yml` runs with
   no `environment:`, so an environment-scoped secret would reach it empty and
   analytics would ship dark behind a green deploy
   (`backend/tests/unit/config/externalIntegrationWiring.test.ts` pins this
   shape). Staging uses `STAGING_POSTHOG_KEY` and should point at a separate
   project or stay unset.

6. Deploy (tag a release). The next build embeds the key; the Terraform apply
   in the same run puts it in the API Lambda environment.

### Verify

- Sign in to https://familygreenhouse.net/ in a normal window (no GPC, no DNT).
  In PostHog → **Activity**, a `$identify` for your Cognito sub appears within
  a minute, followed by whatever you do — `billing_opened` when you open
  Settings → Billing, `plan_limit_hit` if you trip a cap.
- Watch the next post-deploy smoke run: it must produce **no** PostHog events
  and no `POST /telemetry/product`. The smoke browser declares Global Privacy
  Control and the spec asserts nothing left it
  (`frontend/tests/e2e/post-deploy-smoke.spec.ts`). Events from a "Smoke Test
  Household" in PostHog mean that control has failed, and the release is rolled
  back by the same assertion.
- Build the two funnels described in `docs/analytics.md` ("Funnels worth
  building") — the person-level sign-up funnel and the household-level
  activation-to-paid funnel aggregated by the `household` group.

### Privacy notes

- Cookieless: the shim keeps the Cognito sub in module memory only; nothing is
  written to cookies or web storage, so this rail needs no consent banner.
- Global Privacy Control and Do Not Track each silence the shim entirely — no
  PostHog event, no first-party event, nothing queued.
- Only closed-vocabulary properties leave the browser; the API accept-list in
  `backend/src/models/telemetry.ts` has the same shape.
- Account deletion does not delete the PostHog person. A deletion request that
  names analytics is handled by hand in the PostHog UI (Persons → delete).

### Disabling

Delete the `PRODUCTION_POSTHOG_KEY` secret and redeploy. Both rails read the key
at build/deploy time and no-op without it; the first-party `/telemetry/product`
events keep flowing to CloudWatch.

There is no Google Tag Manager rail. One shipped, unkeyed, until 2026-09-13,
and was removed rather than left one repository variable away from
re-enabling itself.

---

## Google Analytics 4 — website visit counting

Separate from PostHog, website only, never in the native shells. The design,
the measured behaviour and the privacy posture are in `docs/analytics.md`,
"Google Analytics 4"; this section is the setup.

- **Property:** `554850321`, web stream measurement ID `G-L2JN3PQ75P`,
  event-data retention 14 months, Google signals off.
- **Where the ID goes:** `VITE_GA_MEASUREMENT_ID: G-L2JN3PQ75P` in the `build`
  job of `.github/workflows/cd-production.yml`. It is public, so it is a
  literal, not a secret or variable. Nothing else sets it; unset, nothing
  loads. Never put it in `frontend/.env.mobile.production` —
  `scripts/validate-store-release.mjs` fails a store build that has it.
- **CSP:** `script-src https://www.googletagmanager.com`;
  `connect-src`/`img-src https://*.google-analytics.com
https://*.analytics.google.com`, in both `frontend/index.html` and the
  CloudFront policy (Terraform — applied by the next tagged release).
- **GA admin settings the code depends on** (owner, in the GA UI): Enhanced
  measurement → Page views → advanced → **Page changes based on browser
  history events: off** (the app sends its own scrubbed page views); **User-
  provided data collection: off**; Data Processing Terms accepted and the
  account's data-sharing settings off; no Google Ads link.
- **Disabling:** delete that one line in `cd-production.yml` and tag a release.

---

## Google Ads & Meta Conversions API — paid ad conversion reporting

**What we use it for:** `backend/src/utils/adConversions.ts` reports two conversions server-side, from the same trusted backend seams the first-party analytics rail (`capture()`) already uses — `signup_completed` (Cognito email confirmation) and `subscription_paid` (the Stripe webhook, the first time a subscription becomes `active`). See `docs/paid-acquisition-readiness.md` for the full paid-acquisition plan (keywords, ad copy, creative briefs, budget) this supports.

**Without it:** both env vars are unset in every environment today, so `reportAdConversion` is a complete no-op — no network call, not even a log line past a trace. Nothing here creates an ad account or spends money; that's on you, in the ad platforms' own consoles, before any of this does anything.

**Known limitation before you turn this on:** neither platform can actually attribute a conversion to an ad without a click identifier (Google's `gclid`, Meta's `fbclid`/`fbc`), and this app does not capture one yet (see docs/paid-acquisition-readiness.md §5 for that follow-up). Turning these env vars on before that's built will log conversions in each platform's UI, but with degraded-to-absent ad attribution — useful for confirming the pipe works, not yet for optimizing a campaign.

### Setup — Meta Conversions API (implemented, just needs real values)

1. Create the ad account first (business.facebook.com → Events Manager → your Pixel). This repo does not create it.
2. In Events Manager → your Pixel → Settings, generate a **Conversions API access token**.
3. Set `META_CAPI_PIXEL_ID` (the Pixel ID) and `META_CAPI_ACCESS_TOKEN` (the token from step 2) as GitHub Actions secrets, then map them into the backend Lambda environment the same way `STRIPE_SECRET_KEY` and the other backend secrets are wired (see "Production secrets" below) — these are credentials, not `VITE_`-prefixed build-time values, so they belong on the backend, never in the frontend bundle.
4. Deploy. The next signup confirmation or first paid conversion posts to `https://graph.facebook.com/v21.0/{pixel_id}/events` with a SHA-256-hashed email as the only match key (no cookie, no click id yet — see the limitation above).

### Setup — Google Ads Enhanced Conversions (NOT implemented — stub only)

`sendToGoogleAds` in `adConversions.ts` is a documented no-op: Google's conversion-upload path needs OAuth2 (client id/secret + a refresh token from the ad account owner), a developer token (Google's own manual approval process, can take days), and a customer id — none of which can exist before the ad account does. Once you have those:

1. Create the Google Ads account and a **Conversion action** for each of "signup" and "subscribe" (Tools → Conversions).
2. Apply for a developer token (Tools → API Center) — do this early, approval isn't instant.
3. Create an OAuth2 client (Google Cloud Console) and generate a refresh token for the ad account.
4. Come back to `sendToGoogleAds` and wire the `ConversionUploadService.UploadClickConversions` call using those credentials; `GOOGLE_ADS_CONVERSION_ID` already gates it, so setting that var alone will not silently under-report — the stub logs a warning and sends nothing until the call itself is written.

### Verify

- Meta: Events Manager → your Pixel → Test Events, confirm a `CompleteRegistration` (signup) or `Subscribe` (paid conversion) event lands with `action_source: system_generated` and a hashed email — no raw email, ever.
- Both: `docs/paid-acquisition-readiness.md` §5 has the exact log line names (`ad_conversion_report`) to grep in CloudWatch if a platform's own UI is slow to show test traffic.

### Privacy notes

- Server-side only — no client pixel, no browser cookie, consistent with the cookieless posture documented for PostHog above.
- The only identifier ever sent is a SHA-256 hash of a lower-cased, trimmed email (`hashEmail` in `adConversions.ts`). The raw email never leaves the process this hook runs in.
- Never throws to its caller — a bad credential or a platform outage cannot fail a real signup confirmation or a real Stripe webhook delivery.

### Disabling

Unset `META_CAPI_PIXEL_ID` / `META_CAPI_ACCESS_TOKEN` (and leave `GOOGLE_ADS_CONVERSION_ID` unset). `reportAdConversion` short-circuits to a true no-op.

---

## Production secrets — the right way

This doc keeps it simple by putting secrets directly in `terraform.tfvars`. That works but isn't ideal — tfvars can leak via screenshots, terminal scrollback, accidental git adds. The proper path:

1. Create an AWS Secrets Manager secret per credential.
2. Reference via a Terraform `data` block:

   ```hcl
   data "aws_secretsmanager_secret_version" "stripe" {
     secret_id = "family-greenhouse/stripe-secret-key"
   }
   ```

3. Pass `data.aws_secretsmanager_secret_version.stripe.secret_string` to the Lambda env var.

Migration is a separate piece of work and not urgent at sub-1000-user scale, but worth doing before you hand off ops to anyone else.
