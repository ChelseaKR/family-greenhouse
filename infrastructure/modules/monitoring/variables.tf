variable "environment" {
  description = "Environment name"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
}

variable "enable_alarms" {
  description = "Create the CloudWatch metric alarms. Each standard alarm bills ~$0.10/mo, so a stack whose alerts topic has no subscribers (see the check block in main.tf) is paying for notifications nobody receives. Production keeps this true; disable only for stacks nobody is on call for."
  type        = bool
  default     = true
}

variable "enable_dashboard" {
  description = "Create the CloudWatch dashboard. The first three dashboards per account are free, so a second stack's dashboard bills ~$3/mo. Production keeps this true."
  type        = bool
  default     = true
}

variable "enable_cost_anomaly_monitor" {
  description = "Create the account-global Cost Explorer service anomaly monitor. Enable in only one stack per AWS account."
  type        = bool
  default     = true
}

variable "api_gateway_id" {
  description = "HTTP API Gateway ID used by CloudWatch's ApiId dimension"
  type        = string
}

variable "api_access_log_group_name" {
  description = "CloudWatch log group containing structured HTTP API access logs"
  type        = string
}

variable "api_lambda_log_group_name" {
  description = "CloudWatch log group for the API/telemetry Lambda"
  type        = string
}

variable "auth_lambda_log_group_name" {
  description = "CloudWatch log group for the authentication Lambda"
  type        = string
}

variable "reminders_lambda_log_group_name" {
  description = "CloudWatch log group of the hourly reminder scan. Metric filters read its run-summary line."
  type        = string
  default     = ""
}

variable "digests_lambda_log_group_name" {
  description = "CloudWatch log group of the weekly digest / yearly recap function. Metric filters read its run-summary lines."
  type        = string
  default     = ""
}

variable "ses_configuration_set_name" {
  description = "SES configuration set publishing Reputation.BounceRate/ComplaintRate. Empty (no email module) skips the SES alarms."
  type        = string
  default     = ""
}

variable "billing_lambda_log_group_name" {
  description = "CloudWatch log group for the billing Lambda, whose Stripe webhook receiver emits the no-grant log lines this module alarms on"
  type        = string
}

variable "lambda_function_names" {
  description = "List of Lambda function names"
  type        = list(string)
}

variable "alert_email" {
  description = "Email address for alerts"
  type        = string
  default     = ""
}

variable "alert_sms_number" {
  description = "E.164 phone number (e.g. +15551234567) to SMS-page on alerts. Empty = no SMS paging. Requires the account to be out of the SNS SMS sandbox."
  type        = string
  default     = ""
}

variable "dynamodb_table_name" {
  description = "DynamoDB table name for throttle metrics"
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD; breaching 80% actual / 100% forecast emails alert_email."
  type        = string
  default     = "50"
}

variable "lambda_dlq_name" {
  description = "Name of the Lambda/EventBridge dead-letter queue to alarm on. Empty disables the DLQ alarm."
  type        = string
  default     = ""
}

variable "email_forwarder_dlq_name" {
  description = "SQS queue name of the inbound-mail forwarder DLQ. Empty (no domain / email module not provisioned) disables the alarm."
  type        = string
  default     = ""
}

variable "email_forwarder_log_group_name" {
  description = "CloudWatch log group of the inbound-mail forwarder. Empty (no domain / email module not provisioned) disables the unverified-scan filter and alarm."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# External availability (Route 53 health checks)
#
# Every other alarm in this module reads a metric this stack publishes, and
# every one of them sets treat_missing_data = "notBreaching". Individually
# that is right; collectively it means "serving nobody" produces no data
# points and therefore no alarm. These variables create the only monitoring
# in the repo that observes production from OUTSIDE it. See issue #464.
# ---------------------------------------------------------------------------

variable "enable_site_health_check" {
  description = "Create the Route 53 health check that fetches a real site page every 30 seconds, plus the CloudWatch alarm that pages when it fails. ~$2.60/month: $0.50 health check + $1.00 HTTPS + $1.00 string matching + $0.10 alarm. The site is served from CloudFront, so the probe traffic itself is cached static HTML and costs nothing measurable. This is the check that closes issue #464."
  type        = bool
  default     = false
}

variable "enable_api_health_check" {
  description = "Create the Route 53 health check that fetches GET /health every 30 seconds, plus its alarm. ~$2.60/month in Route 53 fees on the same breakdown as the site check, PLUS the traffic it generates: Route 53 probes from ~15 checker locations, so a 30-second interval is ~1.3M extra API Gateway requests, Lambda invocations, DynamoDB reads and log lines per month — call it another $2-4/month. Off by default for that reason: .github/workflows/uptime.yml already checks GET /health every 15 minutes for free. Turn this on to move API-outage detection from 15 minutes and a workflow-failure email to ~3 minutes and the alerts SNS topic."
  type        = bool
  default     = false
}

variable "enable_telemetry_delivery_alarm" {
  description = "Create the alarm that fires when no synthetic telemetry delivery probe has reached this environment's API for two hours — i.e. when a browser probably could not deliver an error report either (issue #576). The alarm itself is ~$0.10/month and the probe traffic is under a cent (~5,760 requests). Note the two metric filters it and its sibling read are created UNCONDITIONALLY, and the custom metrics they publish (FrontendReportsUndelivered, FrontendTelemetryProbe) are ~$0.30/month each — so the honest cost of this whole signal is ~$0.80/month, of which this flag controls $0.10. It sets treat_missing_data = \"breaching\", so ONLY turn it on for an environment that .github/workflows/uptime.yml actually probes: with nothing sending the heartbeat the alarm is correct to page and will do so forever. The uptime workflow probes production (vars.HEALTHCHECK_URL), which is why staging sets this false."
  type        = bool
  default     = false
}

variable "site_health_check_host" {
  description = "Hostname (no scheme, no path) Route 53 fetches to prove the site is serving this app. Empty disables the site health check even when enable_site_health_check is true."
  type        = string
  default     = ""
}

variable "site_health_check_path" {
  description = "Path on site_health_check_host to fetch. Deliberately NOT \"/\": during the 2026-09-04 outage this check exists to catch, `/` was the one route still answering 200 while every other route 403'd for forty minutes (issue #464). A non-prerendered route also exercises CloudFront's 403/404 -> /app-shell.html rewrite, which is the machinery that failed."
  type        = string
  default     = "/login"

  validation {
    condition     = var.site_health_check_path != "/"
    error_message = "site_health_check_path must not be \"/\". Issue #464: during the forty-minute frontend outage this check exists to detect, `/` kept answering 200 while every other route returned 403 — a health check on `/` would have reported that outage as healthy."
  }

  validation {
    condition     = startswith(var.site_health_check_path, "/")
    error_message = "site_health_check_path must start with \"/\"."
  }
}

variable "site_health_check_search_string" {
  description = "Literal string Route 53 must find in the first 5120 bytes of the site response, or the endpoint counts as unhealthy. Defaults to the og:site_name tag `headToTags()` emits on the SPA shell and on every prerendered page (frontend/src/config/seo.ts), so a 200 that is not this app fails. scripts/check-observability.mjs asserts this exact string still appears in frontend/index.html, so a markup change breaks the gate at pre-push rather than false-paging in production."
  type        = string
  default     = "<meta property=\"og:site_name\" content=\"Family Greenhouse\" />"
}

variable "api_health_check_host" {
  description = "Hostname (no scheme, no path) of the API to probe. Empty disables the API health check even when enable_api_health_check is true."
  type        = string
  default     = ""
}

variable "api_health_check_path" {
  description = "Path to GET /health on api_health_check_host, including the API Gateway stage (e.g. \"/production/health\")."
  type        = string
  default     = ""
}

variable "api_health_check_search_string" {
  description = "Literal string Route 53 must find in the API health response. `GET /health` reports status \"degraded\" when its DynamoDB probe fails, so matching on \"ok\" means a reachable-but-broken API is unhealthy here rather than passing on its 200. scripts/check-observability.mjs asserts the handler still serialises this shape."
  type        = string
  default     = "\"status\":\"ok\""
}
