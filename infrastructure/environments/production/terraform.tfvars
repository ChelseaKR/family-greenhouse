environment        = "production"
aws_region         = "us-east-1"
project_name       = "family-greenhouse"
domain_name        = "familygreenhouse.net"
alert_email        = "support@familygreenhouse.net"
email_from_address = "Family Greenhouse <hello@familygreenhouse.net>"
email_reply_to     = "support@familygreenhouse.net"
dmarc_rua_email    = "dmarc@familygreenhouse.net"

# Perenual: only the secret NAME goes through Terraform. The actual API key
# was put into Secrets Manager via the AWS CLI and is never tracked by IAC.
perenual_api_key_secret_id = "family-greenhouse/perenual-api-key"

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

# --- Stripe billing ---
# Price IDs are NOT secret (they're just `price_…` references), so they live
# here. Leaving one "" disables that cadence: an empty monthly ID makes the whole
# plan unbuyable; an empty annual/lifetime ID just hides that interval. The
# SECRET key + webhook secret are NOT here — they come from the STRIPE_SECRET_KEY
# / STRIPE_WEBHOOK_SECRET GitHub Actions secrets via TF_VAR (see cd-production.yml).
#
# ⚠️ These are TEST-MODE ids (sk_test world) for verifying the flow end-to-end.
# Before charging real money, recreate the products in Stripe LIVE mode and
# swap in the live `price_…` ids here AND the live sk_live_/whsec_ in the
# GitHub secrets.
stripe_price_id_garden            = "price_1Tkur4AhnUt8CMG0b07WYF1t" # Garden monthly ($4.99/mo) — TEST
stripe_price_id_garden_annual     = "price_1TkurVAhnUt8CMG0ebSAipxL" # Garden annual ($39.99/yr) — TEST
stripe_price_id_garden_lifetime   = "price_1Tkus1AhnUt8CMG0JkC7YgYO" # Garden lifetime ($149 one-time) — TEST
stripe_price_id_greenhouse        = ""                               # Greenhouse monthly ($9.99/mo)
stripe_price_id_greenhouse_annual = ""                               # Greenhouse annual ($79.99/yr)
