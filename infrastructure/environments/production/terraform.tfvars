environment                    = "production"
aws_region                     = "us-east-1"
project_name                   = "family-greenhouse"
public_registration_enabled    = true
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

# --- AI inference cost caps (per household per UTC month) ---
#
# Enforce the Plant.id identify monthly meter (3 / 30 / 100 by plan) in
# production: block once a household exceeds its allowance, so the real
# per-call Plant.id credit can't be cost-amplified by concurrency. This is the
# ONLY environment that enforces it — the code default and staging are
# tracking-only ("") — so an identify-cap bug is invisible everywhere but here.
identify_metering_enabled = "1"

# Leaf-health checks (Bedrock vision, a fraction of a cent each) and chat
# tokens. Blank = the code default, which is EXACTLY what ran before these
# variables existed: 200 checks and 250k/50k tokens per household per month,
# identical for the free tier and the $9.99 tier. Nothing changes until a
# value is filled in.
#
#   leaf_health_monthly_cap            flat cap, every tier without an override
#   leaf_health_monthly_cap_<tier>     per tier; blank inherits the flat cap;
#                                      "0" = unlimited for that tier
#   chat_budget_{input,output}_tokens  flat token caps, every tier without an
#                                      override; "0" is NOT unlimited (it
#                                      would 429 every turn — leave blank)
#   chat_budget_{input,output}_tokens_<tier>
#                                      per tier; blank inherits the flat pair
#
# Setting any per-tier leaf-health value adds one household read per check
# (the same read identify already makes). A household already past a newly
# lowered cap is blocked until the month rolls over, so lower caps on the 1st.
leaf_health_monthly_cap            = ""
leaf_health_monthly_cap_seedling   = "20"
leaf_health_monthly_cap_garden     = ""
leaf_health_monthly_cap_greenhouse = ""
chat_budget_input_tokens           = ""
chat_budget_output_tokens          = ""

# Free-tier chat: 25% of the flat 250k / 50k. The care assistant is gated to
# Garden and up in code (a Seedling turn is refused with a 402 before any
# budget is reserved), so today this is a floor UNDER that gate, not a live
# spend: it is what a Seedling household would get if the gate were ever
# relaxed (a trial, say), instead of the full paid-tier budget. Garden and
# Greenhouse stay blank (the flat pair). Lowering a cap a household is already
# past blocks it until the month rolls over — change these on the 1st.
chat_budget_input_tokens_seedling    = "62500"
chat_budget_output_tokens_seedling   = "12500"
chat_budget_input_tokens_garden      = ""
chat_budget_output_tokens_garden     = ""
chat_budget_input_tokens_greenhouse  = ""
chat_budget_output_tokens_greenhouse = ""

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
# Price ids stay empty until the reviewed reactivation change supplies
# LIVE-mode ids (see docs/COMMERCIAL-STATUS.md). Payment activity additionally
# requires payments_enabled = "1" below AND commercialHoldActive = false in
# commercial-status.json; a check block in main.tf refuses an apply that opens
# one gate without the other, or that enables payments with blank Stripe
# configuration.
stripe_price_id_garden            = "price_1Tkur4AhnUt8CMG0b07WYF1t"
stripe_price_id_garden_annual     = "price_1TkurVAhnUt8CMG0ebSAipxL"
stripe_price_id_garden_lifetime   = "price_1Tkus1AhnUt8CMG0JkC7YgYO"
stripe_price_id_greenhouse        = "price_1UB7JuAhnUt8CMG05o9ktQLa"
stripe_price_id_greenhouse_annual = "price_1UB7JuAhnUt8CMG0yFUs1tl8"
# Identification top-up pack (ADR 0019): a ONE-TIME price for "20
# identifications, $1.99", created in Stripe LIVE mode. Blank = not for sale;
# POST /billing/top-up/checkout answers 400 TOP_UP_NOT_CONFIGURED and no credit
# is ever granted. Owner step: create the product + one-time price in Stripe
# LIVE mode, paste its id here, re-attest stripe_price_ids_are_live, apply.
stripe_price_id_identify_top_up = ""
# Manual confirmation gate (see check block in main.tf): only set true once
# every non-empty stripe_price_id_* above has been verified to exist in the
# SAME Stripe mode (test/live) as the STRIPE_SECRET_KEY secret. Terraform
# cannot check this automatically — price ids don't encode their mode.
#
# Attested by the repository owner on 2026-09-02: all five ids above were
# created in Stripe LIVE mode.
stripe_price_ids_are_live = true

# Enable only after Stripe Tax registrations and product tax codes are live.
stripe_automatic_tax_enabled = ""

# Runtime commercial gate. The backend compares this to the literal string
# "1"; every other value disables Checkout and billing-portal creation before
# any configuration, DynamoDB, or Stripe access. Flip to "1" only in the same
# reviewed change that sets commercialHoldActive = false, and only once the
# five price ids above are populated with verified LIVE-mode ids.
#
# This is also the fastest kill switch: returning it to "0" and applying stops
# all new payment activity without a code change or a frontend deploy.
#
# Opened 2026-09-02, after the v0.23.2 deploy wired the live price ids and
# proved the Stripe webhook secret reached the Lambda.
payments_enabled = "1"
