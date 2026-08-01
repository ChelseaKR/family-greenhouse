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
