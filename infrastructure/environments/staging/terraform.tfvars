environment                 = "staging"
aws_region                  = "us-east-1"
project_name                = "family-greenhouse"
public_registration_enabled = true
domain_name                 = ""
alert_email                 = ""

# Staging monitoring is off. Its alarms routed to the family-greenhouse-alerts-
# staging SNS topic, and alert_email above is empty, so the topic has zero
# subscribers — 18 alarms plus a dashboard were billing ~$5.60/month to notify
# nobody. They were deleted from the account; these flags stop the next apply
# from recreating them.
#
# To re-enable: set alert_email (or alert_sms_number) so the topic actually has
# a destination, then flip these back to true. Leaving them true with no
# subscriber trips the alarms_have_a_notification_destination check in
# modules/monitoring and rebuys the same silent bill.
enable_monitoring_alarms    = false
enable_monitoring_dashboard = false

# External availability probes are off here for the same reason: staging has no
# alerts destination and nobody is on call for it, so a Route 53 health check
# would bill ~$2.60/month to publish a metric no alarm reads. Production sets
# both from the root defaults (site check on, API check off). Turning the site
# check on here means paying for it — see modules/monitoring/variables.tf for
# the cost breakdown.
enable_site_health_check = false
enable_api_health_check  = false

# The frontend-rail heartbeat alarm (issue #576) is off here for a stronger
# reason than cost. It sets treat_missing_data = "breaching" on a metric fed by
# .github/workflows/uptime.yml, and that workflow probes PRODUCTION only
# (vars.HEALTHCHECK_URL). Enabled here it would find no heartbeat, correctly
# conclude that nothing can deliver a telemetry report to staging, and page
# about it every two hours forever. Turning it on means also giving the uptime
# workflow a staging endpoint to probe.
enable_telemetry_delivery_alarm = false

# --- AI inference cost caps (per household per UTC month) ---
# Identify metering is tracking-only here (and in the code default): usage is
# counted and returned, never blocked. Only production sets "1". Made explicit
# so the staging/production difference is visible in a diff, not implied.
identify_metering_enabled = ""

# Leaf-health and chat caps: blank = code default (200 checks and 250k/50k
# tokens per household per month, every tier) — the behaviour this environment
# has always had. Production's tfvars explains each lever before you set one.
leaf_health_monthly_cap            = ""
leaf_health_monthly_cap_seedling   = ""
leaf_health_monthly_cap_garden     = ""
leaf_health_monthly_cap_greenhouse = ""
chat_budget_input_tokens           = ""
chat_budget_output_tokens          = ""
# Per-tier chat caps: blank inherits the flat pair above. Production's tfvars
# explains the lever (and why "0" is never the answer).
chat_budget_input_tokens_seedling    = ""
chat_budget_output_tokens_seedling   = ""
chat_budget_input_tokens_garden      = ""
chat_budget_output_tokens_garden     = ""
chat_budget_input_tokens_greenhouse  = ""
chat_budget_output_tokens_greenhouse = ""

# --- Stripe billing (TEST MODE ONLY) ---
# Staging exists to exercise the full checkout -> webhook -> entitlement loop
# against Stripe test mode, where card 4242 4242 4242 4242 succeeds and no real
# money moves. Populate these with `price_...` ids created in Stripe TEST mode
# and pair them with an sk_test_ secret key; mixing modes fails at checkout.
# Secrets arrive via TF_VAR_stripe_secret_key / TF_VAR_stripe_webhook_secret.
stripe_price_id_garden            = "price_1UB3BqAhnUt8CMG0kKrUqeEf"
stripe_price_id_garden_annual     = "price_1UB39YAhnUt8CMG0n38Jx1Ol"
stripe_price_id_garden_lifetime   = "price_1UB39YAhnUt8CMG0z0D2bIqs"
stripe_price_id_greenhouse        = "price_1UB3AhAhnUt8CMG0oeGJZKqH"
stripe_price_id_greenhouse_annual = "price_1UB3A7AhnUt8CMG0kyrXPGtH"
# Identification top-up pack (ADR 0019): a ONE-TIME test-mode price for
# "20 identifications, $1.99". Blank = not for sale; checkout answers 400
# TOP_UP_NOT_CONFIGURED and nothing is granted. Owner step: create the price in
# Stripe TEST mode, paste its id here, apply.
stripe_price_id_identify_top_up = ""
# Stays false in staging: these ids are test-mode by design, and the check
# block in main.tf only requires the attestation for an sk_live_ key.
stripe_price_ids_are_live = false

stripe_automatic_tax_enabled = ""

# Runtime commercial gate, exactly as in production. Open here FIRST, so the
# full checkout -> webhook -> entitlement loop is exercised against Stripe test
# mode before production is ever considered. Production has its own value and
# is unaffected by this.
payments_enabled = "1"
