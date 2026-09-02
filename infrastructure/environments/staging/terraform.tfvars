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
# Stays false in staging: these ids are test-mode by design, and the check
# block in main.tf only requires the attestation for an sk_live_ key.
stripe_price_ids_are_live = false

stripe_automatic_tax_enabled = ""

# Runtime commercial gate, exactly as in production. Open here FIRST, so the
# full checkout -> webhook -> entitlement loop is exercised against Stripe test
# mode before production is ever considered. Production has its own value and
# is unaffected by this.
payments_enabled = "1"
