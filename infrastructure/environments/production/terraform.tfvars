environment                    = "production"
aws_region                     = "us-east-1"
project_name                   = "family-greenhouse"
domain_name                    = "familygreenhouse.net"
application_domain             = "familygreenhouse.net"
hosted_zone_name               = "familygreenhouse.net"
application_domain_include_www = true
alert_email                    = "support@familygreenhouse.net"
email_from_address             = "Family Greenhouse <hello@familygreenhouse.net>"
email_reply_to                 = "support@familygreenhouse.net"
dmarc_rua_email                = "dmarc@familygreenhouse.net"

# Perenual: only the secret NAME goes through Terraform. The actual API key
# was put into SSM Parameter Store via the AWS CLI and is never tracked by IAC.
perenual_api_key_parameter_name = "/family-greenhouse/perenual-api-key"

# CI/CD: provisions the GitHub OIDC provider + deploy role (modules/cicd).
# The role ARN goes into the AWS_DEPLOY_ROLE_ARN + AWS_PRODUCTION_ROLE_ARN
# repo secrets. Trust is bound to this repo's main branch + v* tags +
# the 'production' GitHub environment.
github_org  = "ChelseaKR"
github_repo = "family-greenhouse"

# Cost guardrail. The running app is ~$2-3/mo; this catches a runaway. Cost
# Anomaly Detection (monitoring module) handles spend *spikes* separately.
monthly_budget_usd = "30"

# Enforce the Plant.id identify monthly meter in production (block once a
# household exceeds its cap) so the real per-call Plant.id credit can't be
# cost-amplified by concurrency. Beta default is tracking-only ("").
identify_metering_enabled = "1"

# Keep SMS fail-closed until AWS approves SMS Production Access in us-east-1
# and the required origination identity/registration is active. Once both are
# confirmed, change this to "1" and deploy; the API returns 503 while disabled
# instead of claiming that an undelivered verification code was sent.
sms_notifications_enabled = ""

# --- Stripe billing ---
# Price IDs are NOT secret (they're just `price_…` references), so they live
# here. Leaving one "" disables that cadence: an empty monthly ID makes the whole
# plan unbuyable; an empty annual/lifetime ID just hides that interval. The
# SECRET key + webhook secret are NOT here — they come from the STRIPE_SECRET_KEY
# / STRIPE_WEBHOOK_SECRET GitHub Actions secrets via TF_VAR (see cd-production.yml).
#
# ⚠️ Price ids are identical-looking in test and live mode (both `price_…`), so
# the mode here MUST match the secret key's mode: live prices need an sk_live_
# key, test prices need sk_test_. Mixing them fails at checkout. Live prices +
# live keys charge real cards (the 4242 test card is rejected); test prices +
# sk_test_ let you verify with 4242.
#
# Commercial hold effective 2026-07-14: all price ids remain empty. The API
# also requires PAYMENTS_ENABLED=1, which this repository's infrastructure
# intentionally does not supply. Do not add live-mode ids while the hold is in
# effect.
stripe_price_id_garden            = ""
stripe_price_id_garden_annual     = ""
stripe_price_id_garden_lifetime   = ""
stripe_price_id_greenhouse        = ""
stripe_price_id_greenhouse_annual = ""

# Manual confirmation gate (see check block in main.tf): only set true once
# every non-empty stripe_price_id_* above has been verified to exist in the
# SAME Stripe mode (test/live) as the STRIPE_SECRET_KEY secret. Terraform
# cannot check this automatically — price ids don't encode their mode.
stripe_price_ids_are_live = false

# Enable only after Stripe Tax registrations and product tax codes are live.
stripe_automatic_tax_enabled = ""
