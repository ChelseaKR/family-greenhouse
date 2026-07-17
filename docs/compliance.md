# Compliance & trust

> Last verified: 2026-07-05 · Recheck: quarterly, or on any new PII-processing feature

Ready-to-publish legal/trust statements and the requirements that gate two
deferred features (SMS, Sentry). Pair with [`security.md`](security.md),
[`accessibility.md`](accessibility.md), and the in-app `PrivacyPage`/`TermsPage`.

> Status: the app is pre-launch with one (founder) user. These are drafted so
> they're ready the moment real users — especially any EU/California user —
> arrive. None is legal advice; have counsel review before relying on them.

---

## 1. Accessibility conformance statement (ready to publish)

Publish in the footer and/or a `/legal/accessibility` route.

> **Accessibility**
> Family Greenhouse is built to conform to **WCAG 2.2 Level AA**. We test every
> release with automated tooling (axe-core + Lighthouse, enforced in CI) and fix
> AA issues as a release blocker. We aim for Level AAA where feasible (e.g.
> enhanced contrast, 44px touch targets) but do not claim full AAA conformance.
> Found a barrier? Email <support@familygreenhouse.net> and we'll respond within
> 5 business days.

Backing: AA is enforced in CI (`tests/e2e/a11y*.spec.ts`); see
[`accessibility.md`](accessibility.md) for the per-criterion detail.

---

## 2. CCPA / "we do not sell your data" (ready to publish)

Add to the privacy policy (US/California users).

> **Your California privacy rights (CCPA/CPRA)**
> We **do not sell or share** your personal information, and we never have.
> You can access or delete your data at any time from **Settings → Account**
> (export as JSON/CSV; permanent deletion via _Delete account_), or email
> <support@familygreenhouse.net>. We will not discriminate against you for
> exercising these rights.

Backing: no data sale (no ad networks / data brokers); self-serve export
(`GET /me/export`, CSV in the UI) and delete (`DELETE /me`) already exist.

---

## 3. GDPR / Data Processing Agreement (note + checklist)

For any EU user/customer:

- **Lawful basis:** contract (providing the service the user signed up for).
- **Data subject rights:** access + erasure are self-serve (export / delete account). Document the request path in the privacy policy.
- **Sub-processors:** AWS (hosting), Stripe (billing), and the optional enrichment APIs (Perenual, Plant.id, OpenWeather) when enabled. Maintain a public sub-processor list; each has a standard DPA you reference rather than negotiate.
- **DPA:** offer AWS's and Stripe's standard DPAs by reference; provide a short Family-Greenhouse DPA addendum for B2B customers who ask. Not needed for consumer users in most cases, but have a template ready.
- **Account deletion caveat to disclose:** `DELETE /me` removes login + personal data but preserves household _activity history_ under a pseudonymized member name (so a shared household's record stays coherent). State this explicitly in the privacy policy.

---

## 4. SMS / TCPA — requirements BEFORE enabling SMS

SMS notifications are currently **gated off** (`SMS_NOTIFICATIONS_ENABLED` unset). **Do not enable SMS in production until all of the following exist**, or you risk TCPA liability (statutory damages per message):

1. **Explicit, logged opt-in** — the user must affirmatively check a box to receive SMS, with consent timestamp + the exact consent language stored. A pre-checked box is not consent.
2. **Phone-number verification** — send a one-time code and verify it before the number can receive any notification (prevents sending to a number the user mistyped or doesn't own). Implemented; production delivery remains gated on AWS SMS production access and origination registration.
3. **STOP / unsubscribe** — honor inbound STOP, and include opt-out guidance ("Reply STOP to unsubscribe") in messages. Wire SNS opt-out handling.
4. **Quiet hours / DND** — already implemented (`isInDndWindow`); keep it.
5. **Records** — retain consent + opt-out records.

Until #1–#3 are built, SMS stays off. Email + web push are unaffected (transactional, lower risk).

---

## 5. Error monitoring and optional Sentry

Baseline monitoring is first-party: backend errors, sanitized frontend errors, and Core Web Vitals reach CloudWatch, with the data-minimizing contract documented in [`observability.md`](observability.md). Sentry is an optional secondary rail. Its plumbing is shipped (backend `SENTRY_DSN` Lambda env + `instrument()` router wrap; frontend `VITE_SENTRY_DSN` build-conditional lazy load) and remains a no-op until a DSN is provisioned. To turn it on:

1. Create a Sentry project (one for the React frontend, optionally one for the Node Lambdas).
2. **Backend:** set `var.sentry_dsn` (+ `sentry_traces_sample_rate`) in `environments/production/terraform.tfvars`, `terraform apply`. The router-level `instrument()` then reports unhandled Lambda exceptions.
3. **Frontend:** set `VITE_SENTRY_DSN` (+ `VITE_GIT_SHA`) at build time (see `scripts/deploy.sh` / the CD build env), rebuild + deploy. The SDK then ships as a lazy chunk and initializes.
4. Verify by triggering a test error in each and confirming it lands in Sentry.

See [`external-services-setup.md`](external-services-setup.md) for the broader secrets-provisioning context.

---

## 6. Paging / on-call

Alerts (CloudWatch alarms, budget, cost-anomaly, DLQ, failed-login) fan out to the `alerts` SNS topic, which emails `alert_email`. For real paging:

- **SMS paging:** set `var.alert_sms_number` in tfvars (E.164, e.g. `+15551234567`) and `terraform apply` — it subscribes that number to the alerts topic so SEV-worthy alarms also text you. (Requires the account to be out of the SNS SMS sandbox.)
- **Escalation:** for a true on-call rotation, point the SNS topic at PagerDuty/Opsgenie (an HTTPS subscription) instead of/in addition to email+SMS. See [`incidents.md`](incidents.md) for SEV levels and the (currently solo) escalation path.
