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
3. Put it in your tfvars (DON'T commit a real key — see "Production secrets" at the bottom of this doc for the recommended Secrets Manager path):

   ```hcl
   # infrastructure/environments/production/terraform.tfvars
   perenual_api_key = "pe-XXXXXXXXXXXXXXXXXX"
   ```

4. `terraform apply -var-file=environments/production/terraform.tfvars`. The 13 Lambdas get the env var updated in place.
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
3. Add to tfvars:

   ```hcl
   plant_id_api_key = "XXXXXXXXXXXXXXXXXXXXX"
   ```

4. `terraform apply`. Verify with the Add Plant → photo flow in the UI.

---

## Stripe — billing

**What we use it for:** `POST /billing/checkout` for plan upgrades, `POST /billing/webhook` for subscription state updates, `POST /billing/portal` for self-service management.

**Currently:** the entire payment surface is hidden by the `VITE_BETA_MODE=true` flag (see `frontend/src/lib/betaMode.ts`). Pricing cards say "Free during beta" and the upgrade buttons are disabled. Wire Stripe before you flip beta mode off, OR users will see live pricing buttons that 500 on click.

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
3. Flip `VITE_BETA_MODE=false` in the production frontend build env. The pricing UI un-hides.
4. **Tax**: configure registrations in Stripe Tax, assign the appropriate SaaS tax code to each product, then set `stripe_automatic_tax_enabled = "1"`. Checkout will collect the minimum billing-address fields required and save refreshed addresses for returning customers. Do not flip this flag before the Stripe-side tax setup is complete.

### Checkout reliability and webhook checks

- The frontend sends a UUID for each checkout attempt. The API scopes it to the household and forwards it as Stripe's idempotency key, so transport retries return the original Checkout Session instead of creating another one.
- Keep the webhook event list above narrow. The async-payment event is required for a lifetime purchase that completes after `checkout.session.completed` initially reports `unpaid`.
- Stripe can deliver an event more than once and does not guarantee ordering. The app records processed event IDs and conditions household updates on Stripe's event timestamp; do not remove either guard.
- Before going live, complete one monthly, annual, and lifetime test checkout; replay a webhook from Stripe Workbench; and verify the household plan, customer ID, subscription ID, and period end in DynamoDB.

---

## SES — transactional email

**What we use it for:** Cognito-sent confirmation + password reset emails (now branded as `hello@familygreenhouse.net` via the SES domain identity), and reminder delivery via the EventBridge-invoked reminders Lambda.

**Currently:** domain identity verified, DKIM live, but **SES is still in the AWS sandbox** — only verified recipient addresses can receive mail.

### Sandbox exit (the only thing left to do)

1. AWS Console → Support → Create case → Service quota increase
2. **Service**: SES
3. **Region**: us-east-1
4. **Quota**: Sending limits (move out of sandbox)
5. **Use case description** — paste:

   > Family Greenhouse is a personal-scale plant-care SaaS at familygreenhouse.net.
   > Transactional emails: Cognito signup confirmations, password resets,
   > plant-care reminders. Recipients are users who explicitly opted in via
   > account signup. We honor unsubscribe via the user-controlled notification
   > preferences page. Daily volume estimate at GA: <500 emails.

6. AWS usually approves in 24–48 hours for low-volume transactional cases.

---

## Sentry — error monitoring

**What we use it for:** Backend error reporting via `instrument()` wrapping each Lambda dispatcher; frontend error reporting via `frontend/src/sentry.ts` (already initialized when `VITE_SENTRY_DSN` is set).

### Setup

1. Sign up at https://sentry.io/, create a project for "Node.js (AWS Lambda)" and another for "React".
2. Copy each project's DSN.
3. tfvars:

   ```hcl
   sentry_dsn                = "https://<backend-dsn>@sentry.io/<id>"
   sentry_traces_sample_rate = "0.1"
   git_sha                   = "" # CI sets this; leave blank locally
   ```

4. For frontend: set `VITE_SENTRY_DSN` in the production frontend build env (or the CD workflow).
5. `terraform apply`. Existing Lambda containers pick up the new env var on next invocation (~5 min for full rollout).

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

2. tfvars:

   ```hcl
   web_push_vapid_public_key  = "BAAAA..."
   web_push_vapid_private_key = "AAAA..."
   web_push_vapid_subject     = "mailto:hello@familygreenhouse.net"
   ```

3. Also set `VITE_VAPID_PUBLIC_KEY` in the frontend build env to the same public key — the browser subscription flow uses it.
4. `terraform apply`. Frontend rebuild.

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

4. **Frontend env**:

   ```bash
   VITE_GTM_ID=GTM-XXXXXXX  # set in production frontend build env
   ```

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
