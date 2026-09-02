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
   - Events to send: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
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

## Google Tag Manager + GA4

**What we use it for:** Independent analytics rail alongside the PostHog shim. When `VITE_GTM_ID` is set at build time, every `track()` event in `frontend/src/services/analytics.ts` pushes to `window.dataLayer`, and GTM forwards to GA4 (and anywhere else you configure tags for).

### Setup

1. **Google Analytics 4**:
   - https://analytics.google.com/ → Admin → Create property → "Family Greenhouse"
   - Set up a Web data stream → enter `https://familygreenhouse.net` → submit
   - Copy the **Measurement ID** (`G-XXXXXXXXXX`) — you'll use it inside GTM, NOT in our env.

2. **Google Tag Manager**:
   - https://tagmanager.google.com/ → Create account → container type **Web**
   - Copy the **Container ID** (`GTM-XXXXXXX`).

3. **Wire GTM → GA4 inside the GTM UI**:
   - In GTM, Tags → New → Tag Type "Google Analytics: GA4 Configuration" → Measurement ID = the GA4 `G-` value → Trigger "All Pages".
   - Tags → New → Tag Type "Google Analytics: GA4 Event" → Event Name `{{Event}}` (built-in variable) → Trigger "Custom Event" with regex `.*`. This forwards every event we push to `dataLayer` as a GA4 event with the same name.
   - **Publish** the container (top-right "Submit").

4. Set the `PRODUCTION_GTM_ID` GitHub Actions repository variable to the
   container id (and `STAGING_GTM_ID` for staging). The deploy workflow maps it
   to `VITE_GTM_ID` in the frontend build.

5. CloudFront's CSP already allows `googletagmanager.com` + `google-analytics.com` endpoints. If you ever tighten CSP later, keep these script-src + connect-src + img-src allowances.

### Verify

- Visit https://familygreenhouse.net/ in a private window.
- Sign in (the `identify` call initializes GTM — landing-page visitors don't trigger the load until they're logged in).
- Sign up a new plant or complete a task.
- In GA4, Reports → Real-time → check that the events appear under "Event count by event name".

### Privacy notes

- The shim respects browser Do-Not-Track (`navigator.doNotTrack === '1'` → all GTM + PostHog events are dropped).
- GTM's Consent Mode is NOT configured here. If you take EU traffic, surface a cookie banner before enabling GTM, and configure Consent Mode v2 in GTM to gate the GA4 tag on user consent.
- The events we push include `plan_id`, `task_type`, `member_count` buckets, and Cognito sub as the user identifier. No plant names, no household names, no email addresses.

### Disabling

Unset `VITE_GTM_ID` and redeploy. The shim short-circuits to no-op; the GTM script never loads.

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
