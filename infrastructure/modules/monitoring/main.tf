# SNS Topic for Alerts
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts-${var.environment}"

  tags = {
    Name = "${var.project_name}-alerts-${var.environment}"
  }
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alert_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Optional SMS paging — alarms text this number in addition to email. Inert
# until alert_sms_number is set in tfvars (E.164). Needs the account out of
# the SNS SMS sandbox to deliver to unverified numbers.
resource "aws_sns_topic_subscription" "sms" {
  count = var.alert_sms_number != "" ? 1 : 0

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "sms"
  endpoint  = var.alert_sms_number
}

# Monthly cost guardrail. A serverless household app should cost a few
# dollars/month; a runaway (e.g. a DDB throttle retry-storm or a Bedrock
# loop) is the realistic surprise. Budgets only support email/SNS
# subscribers directly, so notifications go to alert_email — the same
# address already on the alerts topic — when one is configured. The budget
# itself is always created for console visibility.
resource "aws_budgets_budget" "monthly_cost" {
  name         = "${var.project_name}-monthly-cost-${var.environment}"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Alert at 80% of actual spend (early warning)...
  dynamic "notification" {
    for_each = var.alert_email != "" ? [1] : []
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = 80
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  # ...and when the month is *forecast* to exceed 100% (catches a spike
  # before the bill actually lands).
  dynamic "notification" {
    for_each = var.alert_email != "" ? [1] : []
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = 100
      threshold_type             = "PERCENTAGE"
      notification_type          = "FORECASTED"
      subscriber_email_addresses = [var.alert_email]
    }
  }
}

# Cost anomaly detection. Catches an unusual spend spike per-service (e.g. a
# Bedrock day that 10x's the baseline) even when it's still under the monthly
# budget — the budget alarm only fires at a fixed dollar ceiling, this fires on
# *shape*. Free. Cost Explorer is a us-east-1-global service (this stack's
# region), so it lives in the default provider.
resource "aws_ce_anomaly_monitor" "services" {
  count = var.enable_cost_anomaly_monitor ? 1 : 0

  name              = "${var.project_name}-anomaly-${var.environment}"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

# Preserve the existing production monitor while making this account-global
# resource optional for secondary stacks such as staging.
moved {
  from = aws_ce_anomaly_monitor.services
  to   = aws_ce_anomaly_monitor.services[0]
}

resource "aws_ce_anomaly_subscription" "alerts" {
  count = var.enable_cost_anomaly_monitor && var.alert_email != "" ? 1 : 0
  name  = "${var.project_name}-anomaly-sub-${var.environment}"
  # EMAIL subscribers only support DAILY/WEEKLY (IMMEDIATE needs an SNS topic).
  # DAILY = one digest email of the day's anomalies.
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services[0].arn]

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }

  # Alert when a single anomaly's total impact is >= $10. Tune up if normal
  # dev-tooling (Claude Code on Bedrock) noise trips it too often.
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["10"]
    }
  }
}

# User-facing service-level signals come from the structured API access log.
# Native API Gateway metrics remain as a platform backstop, but application
# request/error panels deliberately exclude GET /health so external probe
# traffic cannot swamp the two real users' traffic or error rate. That
# exclusion is load-bearing: `.github/workflows/uptime.yml` polls /health
# every 15 minutes, and the optional Route 53 API health check at the bottom
# of this file polls it every 30 seconds from ~15 locations, which is roughly
# 1.3M requests a month against a handful of real ones.
resource "aws_cloudwatch_dashboard" "main" {
  count = var.enable_dashboard ? 1 : 0

  dashboard_name = "${var.project_name}-${var.environment}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway Requests"
          region = data.aws_region.current.name
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", var.api_gateway_id]
          ]
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway errors (4xx + 5xx)"
          region = data.aws_region.current.name
          # Two stacked series so 4XX (client) and 5XX (server) are
          # distinguishable at a glance — they imply very different actions.
          metrics = [
            ["AWS/ApiGateway", "5xx", "ApiId", var.api_gateway_id, { stat = "Sum" }],
            [".", "4xx", ".", ".", { stat = "Sum" }]
          ]
          period  = 300
          view    = "timeSeries"
          stacked = false
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Application p95 latency by route (health excluded)"
          region = data.aws_region.current.name
          query  = "SOURCE '${var.api_access_log_group_name}' | filter routeKey != 'GET /health' | stats pct(responseLatency, 95) as p95_ms by routeKey"
          view   = "bar"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Application 5xx by route (health excluded)"
          region = data.aws_region.current.name
          query  = "SOURCE '${var.api_access_log_group_name}' | filter routeKey != 'GET /health' and status >= 500 | stats count(*) as errors by routeKey, bin(5m)"
          view   = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Application requests + 5xx (health excluded)"
          region = data.aws_region.current.name
          metrics = [
            ["FamilyGreenhouse/API/${var.environment}", "ApplicationRequests", { label = "requests", stat = "Sum" }],
            [".", "Application5xx", { label = "5xx", stat = "Sum" }]
          ]
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Lambda errors"
          region = data.aws_region.current.name
          metrics = [
            for name in var.lambda_function_names : ["AWS/Lambda", "Errors", "FunctionName", name]
          ]
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "Browser errors"
          region = data.aws_region.current.name
          query  = "SOURCE '${var.api_lambda_log_group_name}' | filter msg = 'frontend_telemetry' and kind = 'error' | stats count(*) as errors by route, bin(5m)"
          view   = "timeSeries"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "Core Web Vitals p75 (selected range)"
          region = data.aws_region.current.name
          # LCP/INP are milliseconds while CLS is unitless; a table avoids a
          # misleading shared axis that would visually flatten CLS to zero.
          query = "SOURCE '${var.api_lambda_log_group_name}' | filter msg = 'frontend_telemetry' and kind = 'vital' | stats pct(value, 75) as p75, count(*) as samples by metric"
          view  = "table"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "DynamoDB throttled requests"
          region = data.aws_region.current.name
          metrics = var.dynamodb_table_name == "" ? [] : [
            ["AWS/DynamoDB", "ReadThrottleEvents", "TableName", var.dynamodb_table_name],
            [".", "WriteThrottleEvents", ".", "."]
          ]
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "Perenual budget exhaustions (species routes)"
          region = data.aws_region.current.name
          query  = "SOURCE '/aws/lambda/${var.project_name}-species-${var.environment}' | filter msg = 'perenual.budget_exhausted' | stats count(*) by bin(5m)"
          view   = "timeSeries"
        }
      }
    ]
  })
}

# Keep the existing (production) dashboard in place now that the resource is
# counted — without this, adding `count` would move the state address from
# .main to .main[0] and Terraform would destroy and recreate the dashboard.
moved {
  from = aws_cloudwatch_dashboard.main
  to   = aws_cloudwatch_dashboard.main[0]
}

data "aws_region" "current" {}

# Health-excluded RED metrics derived from the structured access log. These
# are the SLO source of truth; the native AWS/ApiGateway Count metric includes
# the high-frequency synthetic health check and is therefore not user traffic.
resource "aws_cloudwatch_log_metric_filter" "application_requests" {
  name           = "${var.project_name}-application-requests-${var.environment}"
  log_group_name = var.api_access_log_group_name
  pattern        = "{ $.routeKey != \"GET /health\" }"

  metric_transformation {
    name          = "ApplicationRequests"
    namespace     = "FamilyGreenhouse/API/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "application_5xx" {
  name           = "${var.project_name}-application-5xx-${var.environment}"
  log_group_name = var.api_access_log_group_name
  pattern        = "{ $.routeKey != \"GET /health\" && $.status = 5* }"

  metric_transformation {
    name          = "Application5xx"
    namespace     = "FamilyGreenhouse/API/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "application_latency" {
  name           = "${var.project_name}-application-latency-${var.environment}"
  log_group_name = var.api_access_log_group_name
  pattern        = "{ $.routeKey != \"GET /health\" && $.responseLatency = * }"

  metric_transformation {
    name      = "ApplicationLatency"
    namespace = "FamilyGreenhouse/API/${var.environment}"
    value     = "$.responseLatency"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "frontend_errors" {
  name           = "${var.project_name}-frontend-errors-${var.environment}"
  log_group_name = var.api_lambda_log_group_name
  pattern        = "{ $.msg = \"frontend_telemetry\" && $.kind = \"error\" }"

  metric_transformation {
    name          = "FrontendErrors"
    namespace     = "FamilyGreenhouse/Frontend/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

# ---------------------------------------------------------------------------
# Scheduled-run outcome metrics
#
# The problem these exist for: `reminders.ts:834`, `digest.ts:396` and
# `digest.ts:788` each catch a per-household error, increment a `failed`
# counter and log at WARN — which was the right fix, because a swallowed
# error used to abort the run for every member after a bad one. But WARN is
# below every metric filter, and the handlers then RETURN NORMALLY. So a run
# in which every household failed produced no Lambda `Errors` data point,
# nothing in the DLQ, and no signal anywhere. It was byte-identical, from the
# outside, to a quiet week.
#
# The counters are already in the run-summary log lines (`digest.run_complete`,
# `recap.run_complete`, and `reminders.run_complete`, added alongside these
# filters because the reminder scan had no summary line at all). These filters
# turn them into metrics; the alarms below page on a non-zero `failed`.
#
# `sent` is published as its own metric but deliberately NOT alarmed on. A
# "sent should not be zero" alarm needs a floor the product does not have yet:
# at current volume a genuinely quiet week is possible, and an alarm that
# fires on it would be trained away within a month. Publishing the series now
# means the floor can be chosen from real data later rather than guessed.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "reminders_run_failed" {
  count = var.reminders_lambda_log_group_name != "" ? 1 : 0

  name           = "${var.project_name}-reminders-run-failed-${var.environment}"
  log_group_name = var.reminders_lambda_log_group_name
  pattern        = "{ $.msg = \"reminders.run_complete\" && $.failed > 0 }"

  metric_transformation {
    name          = "RemindersHouseholdsFailed"
    namespace     = "FamilyGreenhouse/Scheduled/${var.environment}"
    value         = "$.failed"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "reminders_run_sent" {
  count = var.reminders_lambda_log_group_name != "" ? 1 : 0

  name           = "${var.project_name}-reminders-run-sent-${var.environment}"
  log_group_name = var.reminders_lambda_log_group_name
  pattern        = "{ $.msg = \"reminders.run_complete\" }"

  metric_transformation {
    name          = "RemindersEmailsSent"
    namespace     = "FamilyGreenhouse/Scheduled/${var.environment}"
    value         = "$.sent"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "digests_run_failed" {
  count = var.digests_lambda_log_group_name != "" ? 1 : 0

  name           = "${var.project_name}-digests-run-failed-${var.environment}"
  log_group_name = var.digests_lambda_log_group_name
  # One filter for both routines the function runs: the weekly digest and the
  # yearly recap share a log group and a failure shape.
  pattern = "{ ($.msg = \"digest.run_complete\" && $.failed > 0) || ($.msg = \"recap.run_complete\" && $.failed > 0) }"

  metric_transformation {
    name          = "DigestsHouseholdsFailed"
    namespace     = "FamilyGreenhouse/Scheduled/${var.environment}"
    value         = "$.failed"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "digests_run_sent" {
  count = var.digests_lambda_log_group_name != "" ? 1 : 0

  name           = "${var.project_name}-digests-run-sent-${var.environment}"
  log_group_name = var.digests_lambda_log_group_name
  pattern        = "{ ($.msg = \"digest.run_complete\") || ($.msg = \"recap.run_complete\") }"

  metric_transformation {
    name          = "DigestsEmailsSent"
    namespace     = "FamilyGreenhouse/Scheduled/${var.environment}"
    value         = "$.sent"
    default_value = "0"
  }
}

# Scheduled-run TRUNCATION (#458).
#
# Read this next to the note above, because it closes the hole that note's fix
# would otherwise have opened.
#
# These jobs used to walk every household in a serial loop with no clock in it.
# Past a few hundred households the loop ran past the 30-second Lambda timeout
# and was killed wherever it happened to be — and EventBridge's retry restarted
# it at household #1 and died in the same place, so the tail of the list was
# not delayed, it was unreachable. That failure DID at least produce a Lambda
# `Errors` data point, which the scheduled-function alarm below fires on at
# `> 0`.
#
# `services/scheduledFanOut.ts` now stops cleanly on a deadline and resumes
# next run from where it stopped. That is the fix — but it also means an
# over-long run RETURNS SUCCESSFULLY, which would have deleted the only signal
# the old shape had. That is precisely the defect #461 fixed, re-created from
# the other side. So the run summaries carry `truncated`, and these filters and
# alarms watch it.
#
# A truncated run is not a per-household failure and must not be counted as
# one: nobody was mailed wrongly and nothing was lost. It is a CAPACITY signal
# — the fleet no longer fits its budget — and the remedy is a bigger budget or
# the GSI household directory, not a page at 3am. Hence its own metric rather
# than folding it into `failed`.
resource "aws_cloudwatch_log_metric_filter" "reminders_run_truncated" {
  count = var.reminders_lambda_log_group_name != "" ? 1 : 0

  name           = "${var.project_name}-reminders-run-truncated-${var.environment}"
  log_group_name = var.reminders_lambda_log_group_name
  # Both passes on the hourly schedule: the reminder fan-out and the
  # household-email pass that rides the same invocation.
  pattern = "{ ($.msg = \"reminders.run_complete\" && $.truncated IS TRUE) || ($.msg = \"household_email.run_complete\" && $.truncated IS TRUE) }"

  metric_transformation {
    name          = "RemindersRunTruncated"
    namespace     = "FamilyGreenhouse/Scheduled/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "digests_run_truncated" {
  count = var.digests_lambda_log_group_name != "" ? 1 : 0

  name           = "${var.project_name}-digests-run-truncated-${var.environment}"
  log_group_name = var.digests_lambda_log_group_name
  pattern        = "{ ($.msg = \"digest.run_complete\" && $.truncated IS TRUE) || ($.msg = \"recap.run_complete\" && $.truncated IS TRUE) }"

  metric_transformation {
    name          = "DigestsRunTruncated"
    namespace     = "FamilyGreenhouse/Scheduled/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

# CloudWatch Alarms
#
# Alarm strategy (cost-driven consolidation): standard alarms are ~$0.10/mo
# each, and 2 alarms x 13 Lambdas was ~$2.60/mo mostly spent watching
# zero-traffic functions. Instead:
#   - TWO account-aggregate alarms (AWS/Lambda Errors + Throttles with no
#     FunctionName dimension — CloudWatch publishes these account-level
#     series natively) catch a failure in ANY function.
#   - Per-function Errors/Duration alarms are kept ONLY for the two
#     functions where attribution + tighter signal matter: `reminders`
#     (async/cron — a sync API failure surfaces via the api-5xx alarm and
#     the user, an async one surfaces nowhere else) and `chat` (Bedrock
#     tool-loop, the latency/cost outlier).
locals {
  # Async, no-user-watching functions. `reminders` was already here; `digests`
  # and `emailEvents` were not, for no stated reason — they are cron/SNS
  # invoked and have no user to notice, which is verbatim the argument the
  # strategy note above makes for keeping `reminders`.
  scheduled_lambda_names = [
    for name in var.lambda_function_names : name
    if length(regexall("-(reminders|digests|emailEvents)-", name)) > 0
  ]

  # Functions whose LATENCY is worth its own alarm: the two the strategy note
  # names. A weekly digest legitimately runs long, so a duration alarm on it
  # would page for the job doing its work.
  latency_lambda_names = [
    for name in var.lambda_function_names : name
    if length(regexall("-(reminders|chat)-", name)) > 0
  ]

  error_alarm_lambda_names = distinct(concat(
    local.scheduled_lambda_names,
    [for name in var.lambda_function_names : name if length(regexall("-chat-", name)) > 0],
  ))
}

# Any Lambda error anywhere in the account/region. Coarse by design — the
# dashboard's per-function Errors widget gives the attribution.
resource "aws_cloudwatch_metric_alarm" "lambda_errors_aggregate" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-lambda-errors-aggregate-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Aggregate Lambda errors across all functions exceeded threshold — check the dashboard's per-function Errors widget for attribution"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-lambda-errors-aggregate-alarm-${var.environment}"
  }
}

# Aggregate Throttles rather than aggregate Duration: chat legitimately runs
# 10-30s per turn, so at this app's low traffic an account-wide AVERAGE
# duration alarm would false-page whenever chat is the dominant traffic.
# Throttles is the unambiguous account-wide signal (any value > 0 means we
# hit concurrency limits and shed requests); per-function Duration alarms
# below cover latency for the two functions where it matters, and the
# dashboard's p95 widget covers the rest.
resource "aws_cloudwatch_metric_alarm" "lambda_throttles_aggregate" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-lambda-throttles-aggregate-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Lambda invocations throttled somewhere in the account — concurrency limit hit, requests are being shed"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-lambda-throttles-aggregate-alarm-${var.environment}"
  }
}

# Per-function alarms for the functions the strategy note names (see above).
#
# The threshold is class-dependent, and that is the point of this block. At the
# old flat `> 5 Sum over 2 consecutive 5-minute periods` a scheduled function
# could never trip it: EventBridge retries a failed target at most 4 times
# (infrastructure/modules/api/main.tf), so a completely broken hourly or weekly
# run produces AT MOST 5 Errors data points, spread over a couple of minutes.
# 5 is not > 5, and it certainly is not > 5 in each of two consecutive periods.
# The alarm on `reminders` — kept per-function precisely because "an async
# failure surfaces nowhere else" — was therefore unreachable for the failure it
# was created for. A DLQ message still alarms separately, but only once every
# retry is exhausted, and only for a target that actually threw.
#
# So: any error at all pages for a scheduled function, while `chat` keeps the
# volume-based threshold that suits a user-facing, high-frequency path.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = toset(var.enable_alarms ? local.error_alarm_lambda_names : [])

  alarm_name          = "${each.value}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = contains(local.scheduled_lambda_names, each.value) ? 1 : 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = contains(local.scheduled_lambda_names, each.value) ? 0 : 5
  alarm_description   = "Lambda function ${each.value} errors exceeded threshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  # A function with no invocations in the window has no error data; treat that
  # as healthy (OK) rather than INSUFFICIENT_DATA so a quiet low-traffic
  # function reads green and a real error still trips the alarm.
  treat_missing_data = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  tags = {
    Name = "${each.value}-errors-alarm"
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  for_each = toset(var.enable_alarms ? local.latency_lambda_names : [])

  alarm_name          = "${each.value}-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  # chat legitimately runs 10-30s per turn (Bedrock tool loop, 90s timeout),
  # so it alarms at 60s; everything else keeps the 10s bar.
  threshold         = length(regexall("-chat-", each.value)) > 0 ? 60000 : 10000
  alarm_description = "Lambda function ${each.value} duration exceeded threshold"
  alarm_actions     = [aws_sns_topic.alerts.arn]
  # No invocations = no duration data; quiet reads OK, not INSUFFICIENT_DATA.
  treat_missing_data = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  tags = {
    Name = "${each.value}-duration-alarm"
  }
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_throttle" {
  count = var.enable_alarms && var.dynamodb_table_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-ddb-throttle-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ReadThrottleEvents"
  namespace           = "AWS/DynamoDB"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "DynamoDB read throttling — capacity issue or hot partition"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  # No throttle events published = not throttling = OK, not INSUFFICIENT_DATA.
  treat_missing_data = "notBreaching"

  dimensions = {
    TableName = var.dynamodb_table_name
  }

  tags = {
    Name = "${var.project_name}-ddb-throttle-alarm-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_write_throttle" {
  count = var.enable_alarms && var.dynamodb_table_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-ddb-write-throttle-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "WriteThrottleEvents"
  namespace           = "AWS/DynamoDB"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "DynamoDB write throttling — capacity issue or hot partition"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    TableName = var.dynamodb_table_name
  }

  tags = {
    Name = "${var.project_name}-ddb-write-throttle-alarm-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-api-5xx-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5xx"
  namespace           = "AWS/ApiGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = 2
  alarm_description   = "HTTP API platform 5xx errors exceeded threshold (includes synthetic health traffic)"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  # No 5XX metric published in a quiet window = no server errors = OK.
  treat_missing_data = "notBreaching"

  dimensions = {
    ApiId = var.api_gateway_id
  }

  tags = {
    Name = "${var.project_name}-api-5xx-alarm-${var.environment}"
  }
}

# Immediate user-impact signal. A single non-health 5xx is actionable at the
# current traffic level and must page even when Lambda itself returns a shaped
# 5xx response (which does not increment the Lambda Errors metric).
resource "aws_cloudwatch_metric_alarm" "application_5xx" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-application-5xx-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Application5xx"
  namespace           = "FamilyGreenhouse/API/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A user-facing API route returned 5xx; GET /health is excluded"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "application_latency_p95" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-application-latency-p95-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  metric_name         = "ApplicationLatency"
  namespace           = "FamilyGreenhouse/API/${var.environment}"
  period              = 300
  extended_statistic  = "p95"
  threshold           = 500
  alarm_description   = "Application p95 response latency exceeded the 500ms SLO in two of three periods; GET /health is excluded"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# 99.5% availability SLO, 28-day window. The fast alarm detects a 14.4x burn
# (7.2% errors) sustained across most of one hour; the slow alarm detects a 6x
# burn (3% errors) sustained across most of six hours. Both use the same
# health-excluded application request/error metrics as the dashboard.
resource "aws_cloudwatch_metric_alarm" "availability_fast_burn" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-availability-fast-burn-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 12
  datapoints_to_alarm = 10
  threshold           = 7.2
  alarm_description   = "99.5% availability SLO fast burn: >7.2% application 5xx over most of an hour"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "requests"
    return_data = false
    metric {
      metric_name = "ApplicationRequests"
      namespace   = "FamilyGreenhouse/API/${var.environment}"
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "errors"
    return_data = false
    metric {
      metric_name = "Application5xx"
      namespace   = "FamilyGreenhouse/API/${var.environment}"
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(requests > 0, 100 * errors / requests, 0)"
    label       = "Application 5xx percentage"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "availability_slow_burn" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-availability-slow-burn-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 12
  datapoints_to_alarm = 10
  threshold           = 3
  alarm_description   = "99.5% availability SLO slow burn: >3% application 5xx over most of six hours"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "requests"
    return_data = false
    metric {
      metric_name = "ApplicationRequests"
      namespace   = "FamilyGreenhouse/API/${var.environment}"
      period      = 1800
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "errors"
    return_data = false
    metric {
      metric_name = "Application5xx"
      namespace   = "FamilyGreenhouse/API/${var.environment}"
      period      = 1800
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "error_rate"
    expression  = "IF(requests > 0, 100 * errors / requests, 0)"
    label       = "Application 5xx percentage"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "frontend_errors" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-frontend-errors-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FrontendErrors"
  namespace           = "FamilyGreenhouse/Frontend/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 2
  alarm_description   = "Three or more sanitized browser errors arrived within five minutes"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# Dead-letter queue depth. Any message here = an async invocation (the hourly
# reminders scan) failed past its retries and was dropped to the DLQ — silent
# data loss we want to know about immediately. treat_missing_data=notBreaching
# so a normally-empty queue (no metric emitted) doesn't false-alarm.
resource "aws_cloudwatch_metric_alarm" "lambda_dlq_depth" {
  count = var.enable_alarms && var.lambda_dlq_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-lambda-dlq-not-empty-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Messages in the Lambda DLQ — an async invocation (reminders) failed and was dead-lettered. Inspect + redrive."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = var.lambda_dlq_name
  }

  tags = {
    Name = "${var.project_name}-lambda-dlq-alarm-${var.environment}"
  }
}

# Inbound-mail forwarder DLQ depth. Any message here = a forward (security@ /
# abuse@ / support@ mail) failed past its async retries and was dead-lettered —
# silent loss of mail we explicitly want to see. Separate from lambda_dlq_depth
# (the reminders DLQ) because the email module owns its own queue and is only
# created when a domain is configured. treat_missing_data = notBreaching so a
# normally-empty queue doesn't false-alarm.
resource "aws_cloudwatch_metric_alarm" "email_forwarder_dlq_depth" {
  count = var.enable_alarms && var.email_forwarder_dlq_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-mail-forwarder-dlq-not-empty-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Messages in the inbound-mail forwarder DLQ — a forward (security@/abuse@/support@) failed and was dead-lettered. Inspect + redrive."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = var.email_forwarder_dlq_name
  }

  tags = {
    Name = "${var.project_name}-mail-forwarder-dlq-alarm-${var.environment}"
  }
}

# Inbound mail refused because its scan verdict was not an explicit PASS —
# GRAY, PROCESSING_FAILED, or no verdict at all. The forwarder is fail-closed
# (modules/email/lambda/forwarder.mjs), so this message did NOT reach the
# maintainer's inbox: it is sitting in the inbound-mail bucket at the `key` the
# log line names, waiting for someone to decide. That is exactly the sort of
# thing that must not be discoverable only by reading logs, because the
# addresses this forwarder carries are security@ and abuse@.
#
# Deliberately NOT filtering the everyday `mail_dropped_scan_fail`: a FAIL is
# a scan that ran and worked, on mail nobody wants, and paging on it would
# turn ordinary spam into an alert.
resource "aws_cloudwatch_log_metric_filter" "mail_not_relayed_unverified" {
  count = var.email_forwarder_log_group_name != "" ? 1 : 0

  name           = "${var.project_name}-mail-not-relayed-unverified-${var.environment}"
  log_group_name = var.email_forwarder_log_group_name
  pattern        = "{ $.msg = \"mail_not_relayed_scan_unverified\" }"

  metric_transformation {
    name          = "MailNotRelayedUnverifiedScan"
    namespace     = "FamilyGreenhouse/Audit/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_not_relayed_unverified" {
  count = var.enable_alarms && var.email_forwarder_log_group_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-mail-not-relayed-unverified-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.mail_not_relayed_unverified[0].metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Audit/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Inbound mail to security@/abuse@/support@ was NOT relayed because its spam/virus scan verdict was not an explicit PASS. The raw message is in the inbound-mail bucket at the key named in the log line — retrieve and triage it by hand."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-mail-not-relayed-unverified-alarm-${var.environment}"
  }
}

# Scheduled-run failure alarms. Any household that failed is worth knowing
# about: these jobs run hourly and weekly, so a single alarm cannot be noisy in
# the way a per-request one could, and "some households were not reminded" is
# exactly the state the product promises will not happen.
resource "aws_cloudwatch_metric_alarm" "reminders_run_failed" {
  count = var.enable_alarms && var.reminders_lambda_log_group_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-reminders-run-failed-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.reminders_run_failed[0].metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Scheduled/${var.environment}"
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The hourly reminder scan finished with households it could not remind. The run returns normally and logs at WARN, so without this alarm an hour in which EVERY household failed looks exactly like an hour with nothing due."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-reminders-run-failed-alarm-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "digests_run_failed" {
  count = var.enable_alarms && var.digests_lambda_log_group_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-digests-run-failed-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.digests_run_failed[0].metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Scheduled/${var.environment}"
  # A day, not an hour: the digest runs weekly and the recap yearly, so the
  # evaluation window has to be wide enough to contain the run it is watching.
  period             = 86400
  statistic          = "Sum"
  threshold          = 0
  alarm_description  = "The weekly digest or the yearly recap finished with households it could not mail. Digests can go to zero households for weeks and the first signal is a user saying they stopped arriving — from the population least likely to say anything."
  alarm_actions      = [aws_sns_topic.alerts.arn]
  ok_actions         = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  tags = {
    Name = "${var.project_name}-digests-run-failed-alarm-${var.environment}"
  }
}

# Scheduled runs that could not finish inside their budget. See the metric
# filters above for why this is a separate signal from `failed`.
#
# `> 0` over a window wide enough to contain the run, matching the failure
# alarms: one truncated run means some households were skipped this cycle, and
# the resume only guarantees they are reached EVENTUALLY. Two cycles in a row
# means the fleet is falling behind faster than it catches up.
resource "aws_cloudwatch_metric_alarm" "reminders_run_truncated" {
  count = var.enable_alarms && var.reminders_lambda_log_group_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-reminders-run-truncated-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = aws_cloudwatch_log_metric_filter.reminders_run_truncated[0].metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Scheduled/${var.environment}"
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The hourly reminder scan ran out of its time budget two hours running, so some households were not reached in either. The resume makes them eventually-reminded rather than never-reminded, but two consecutive truncations mean the fleet is outgrowing a 30-second invocation: raise the timeout, or land the GSI household directory that removes the full-table scan."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-reminders-run-truncated-alarm-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "digests_run_truncated" {
  count = var.enable_alarms && var.digests_lambda_log_group_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-digests-run-truncated-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.digests_run_truncated[0].metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Scheduled/${var.environment}"
  # A day, for the same reason as the digest failure alarm: the window has to
  # contain the run it is watching.
  period             = 86400
  statistic          = "Sum"
  threshold          = 0
  alarm_description  = "A weekly digest or yearly recap run stopped on its deadline with households left. Unlike the hourly scan there is no next hour to catch up in — the digest's four Monday runs are the whole budget for the week, so a truncation here can mean a household simply gets no digest that week."
  alarm_actions      = [aws_sns_topic.alerts.arn]
  ok_actions         = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  tags = {
    Name = "${var.project_name}-digests-run-truncated-alarm-${var.environment}"
  }
}

# Bounce rate on the SES configuration set.
#
# `modules/email/events.tf` sets `reputation_metrics_enabled = true` precisely
# so these reach CloudWatch, and until now nothing watched them. The module's
# own header states the stake: sustained bounces cost a domain its sending
# reputation, and that reputation is shared by every message the domain sends,
# password resets included. AWS puts an identity under review at a 5% bounce
# rate and can pause sending, at which point the first symptom anyone sees is
# that nobody can complete a password reset.
#
# On the low-volume false-alarm risk, which is real: these are ROLLING RATE
# metrics, so one bounce in a quiet week can spike the rate. The choice made
# here is `datapoints_to_alarm = 3` over three consecutive hours rather than a
# composite alarm gated on send volume — a single bad address resolves within
# the rolling window, a suppression-list bug or a bad import does not. If this
# proves noisy at current volume, raise `datapoints_to_alarm` before raising
# the threshold: the threshold is set where it is because AWS acts at 5%, and
# an alarm that only fires after AWS has already acted is not an alarm.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  count = var.enable_alarms && var.ses_configuration_set_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-ses-bounce-rate-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "Reputation.BounceRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Average"
  # 3%, well under AWS's 5% review threshold, so there is room to act.
  threshold         = 0.03
  alarm_description = "SES bounce rate above 3% for 3 hours on ${var.ses_configuration_set_name}. AWS reviews at 5% and can pause the identity — at which point password resets stop. Check emailSuppression + recent imports."
  alarm_actions     = [aws_sns_topic.alerts.arn]
  ok_actions        = [aws_sns_topic.alerts.arn]
  # A week with no sends legitimately has no data. Deliberate, not copied: a
  # stopped sender is its own problem and the scheduled-run metrics above are
  # what watch for that.
  treat_missing_data = "notBreaching"

  dimensions = {
    ConfigurationSetName = var.ses_configuration_set_name
  }

  tags = {
    Name = "${var.project_name}-ses-bounce-rate-alarm-${var.environment}"
  }
}

# Complaint rate. AWS's review threshold is 0.1%; 0.05% leaves room to react.
resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  count = var.enable_alarms && var.ses_configuration_set_name != "" ? 1 : 0

  alarm_name          = "${var.project_name}-ses-complaint-rate-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "Reputation.ComplaintRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Average"
  threshold           = 0.0005
  alarm_description   = "SES complaint rate above 0.05% for 3 hours on ${var.ses_configuration_set_name}. AWS reviews at 0.1%. Someone is marking our mail as spam — check what changed in the last send."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ConfigurationSetName = var.ses_configuration_set_name
  }

  tags = {
    Name = "${var.project_name}-ses-complaint-rate-alarm-${var.environment}"
  }
}

# Audit alarm: failed-login spike (possible credential stuffing / brute force).
# A metric filter turns the structured audit log line (pino JSON,
# `event: "auth.login.failure"`) on the auth Lambda's log group into a metric;
# the alarm pages when it spikes. The log group is Lambda-auto-created, so it
# must exist (the auth fn has run in prod) for the filter to apply.
resource "aws_cloudwatch_log_metric_filter" "auth_login_failure" {
  name           = "${var.project_name}-auth-login-failure-${var.environment}"
  log_group_name = var.auth_lambda_log_group_name
  pattern        = "{ $.event = \"auth.login.failure\" }"

  metric_transformation {
    name          = "AuthLoginFailures"
    namespace     = "FamilyGreenhouse/Audit/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_login_failure_spike" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-auth-login-failure-spike-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.auth_login_failure.metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Audit/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "More than 10 failed logins in 5 min — possible credential stuffing / brute force."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-auth-login-failure-alarm-${var.environment}"
  }
}

# ---------------------------------------------------------------------------
# Stripe webhook: the paths that acknowledge an event and grant NOTHING
#
# `applyStripeEvent` (backend/src/services/billing.ts) has branches that log a
# reason, return, and let the handler answer 200. Each one is correct in
# isolation — acknowledging is right when the event is stale, mismatched, or
# not ours — but until now none of them was visible anywhere except a log line
# nobody reads. A metadata contract break, or a run of mismatched
# subscriptions, could drop entitlement grants indefinitely while the delivery
# log in Stripe showed a clean wall of 200s.
#
# TWO metrics rather than one, on purpose. The first three messages should be
# flat zero in normal operation, so any occurrence is worth waking up for. The
# fourth (a first payment that did not settle) is an ordinary business event —
# declined cards happen — and folding it into the same metric would bury the
# contract breaks under routine noise.
#
# Drill down with CloudWatch Logs Insights on the billing log group:
#   fields @timestamp, msg, stripeEventId, householdId, type
#   | filter msg like /stripe_/ | sort @timestamp desc
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "stripe_webhook_no_grant" {
  name           = "${var.project_name}-stripe-webhook-no-grant-${var.environment}"
  log_group_name = var.billing_lambda_log_group_name
  pattern        = "{ $.msg = \"stripe_event_missing_or_unknown_plan_id\" || $.msg = \"stripe_event_subscription_mismatch_skipped\" || $.msg = \"stripe_event_out_of_order_skipped\" }"

  metric_transformation {
    name          = "StripeWebhookNoGrant"
    namespace     = "FamilyGreenhouse/Billing/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "stripe_webhook_no_grant" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-stripe-webhook-no-grant-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.stripe_webhook_no_grant.metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Billing/${var.environment}"
  period              = 900
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A Stripe webhook was acknowledged without granting entitlement (unknown plan metadata, subscription mismatch, or an out-of-order event). Expected to be zero: a paying household may be missing its plan. Query the billing Lambda log group for msg=stripe_event_*."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-stripe-webhook-no-grant-alarm-${var.environment}"
  }
}

resource "aws_cloudwatch_log_metric_filter" "stripe_checkout_unsettled" {
  name           = "${var.project_name}-stripe-checkout-unsettled-${var.environment}"
  log_group_name = var.billing_lambda_log_group_name
  pattern        = "{ $.msg = \"stripe_checkout_session_unsettled_no_grant\" }"

  metric_transformation {
    name          = "StripeCheckoutUnsettled"
    namespace     = "FamilyGreenhouse/Billing/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "stripe_checkout_unsettled_spike" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-stripe-checkout-unsettled-spike-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.stripe_checkout_unsettled.metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Billing/${var.environment}"
  period              = 900
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "More than 10 subscription checkouts in 15 min completed without settling payment. A few declined cards are normal; a spike means a broken price, a payment-method outage, or fraud screening rejecting everyone."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${var.project_name}-stripe-checkout-unsettled-alarm-${var.environment}"
  }
}

# ---------------------------------------------------------------------------
# State moves for the alarm gate
#
# Adding `count` to a resource that never had one moves its state address from
# `.name` to `.name[0]`. Without these blocks Terraform would read that as
# "destroy the old alarm, create a new one" on the next production apply. Each
# alarm below is a no-op address rewrite; the alarm's own configuration is
# untouched, so production keeps every alarm it has today.
# ---------------------------------------------------------------------------
moved {
  from = aws_cloudwatch_metric_alarm.lambda_errors_aggregate
  to   = aws_cloudwatch_metric_alarm.lambda_errors_aggregate[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.lambda_throttles_aggregate
  to   = aws_cloudwatch_metric_alarm.lambda_throttles_aggregate[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.api_5xx
  to   = aws_cloudwatch_metric_alarm.api_5xx[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.application_5xx
  to   = aws_cloudwatch_metric_alarm.application_5xx[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.application_latency_p95
  to   = aws_cloudwatch_metric_alarm.application_latency_p95[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.availability_fast_burn
  to   = aws_cloudwatch_metric_alarm.availability_fast_burn[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.availability_slow_burn
  to   = aws_cloudwatch_metric_alarm.availability_slow_burn[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.frontend_errors
  to   = aws_cloudwatch_metric_alarm.frontend_errors[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.auth_login_failure_spike
  to   = aws_cloudwatch_metric_alarm.auth_login_failure_spike[0]
}

# An alarm nobody receives is cost without coverage. Every alarm above routes
# its alarm_actions to aws_sns_topic.alerts, but that topic only gets a
# subscriber when alert_email or alert_sms_number is set — so a stack can bill
# ~$0.10/alarm/month to notify a topic with zero destinations and look
# monitored while being silent. Staging did exactly that (18 alarms plus a
# dashboard, no subscribers, ~$5.60/mo) before enable_alarms existed.
#
# This is a `check`, not a lifecycle precondition, on purpose: it warns on
# every plan/apply instead of hard-failing, so standing alarms up before the
# destination is wired stays possible while the gap is impossible to miss.
check "alarms_have_a_notification_destination" {
  assert {
    condition = (
      !var.enable_alarms ||
      length(aws_sns_topic_subscription.email) + length(aws_sns_topic_subscription.sms) > 0
    )
    error_message = "enable_alarms is true but the ${var.environment} alerts topic has no subscribers: alert_email and alert_sms_number are both empty, so every alarm here notifies nobody while still billing ~$0.10/month. Set alert_email (and/or alert_sms_number) in this environment's tfvars, or set enable_alarms = false."
  }
}

# ===========================================================================
# External availability — the only monitoring here that can see a total outage
# ===========================================================================
#
# Everything above this line reads a metric THIS STACK publishes, and every
# alarm above sets treat_missing_data = "notBreaching". Each of those choices
# is right on its own: no throttle events means not throttling, no 5xx means
# no errors. Together they mean "the stack served nobody for forty minutes"
# produces zero data points and zero alarms.
#
# That is not hypothetical. On 2026-09-04 the production frontend answered 403
# on every route except `/` for roughly forty minutes. None of the 28 alarms
# fired. The API was healthy throughout, so the 15-minute GitHub Actions
# `/health` curl passed fourteen minutes into it. The outage was found by a
# human loading the site (issue #464).
#
# ## What this section adds, and what it does not replace
#
# `.github/workflows/uptime.yml` stays. It is the DEEPER of the two checks:
# scripts/synthetic-page-check.mjs parses the HTML and asserts the app root
# element, the module script, og:site_name and a non-empty title, on four
# routes, and proves it can still fail via a negative control. What it cannot
# do is run often or report reliably — a 15-minute cron on GitHub's
# best-effort scheduler, which GitHub disables outright on repositories with
# no recent activity, reporting by workflow-failure email rather than to the
# alerts topic every other alarm here uses.
#
# These health checks are the opposite trade. Shallower assertion — HTTP 200
# plus one literal string in the first 5120 bytes — but fetched every 30
# seconds from Route 53's global checker fleet, with the result published as
# a CloudWatch metric that alarms into the same SNS topic as everything else.
# Detection goes from "up to 15 minutes, if the cron ran" to about three
# minutes (90s for the health check to fail three times, then two 60s alarm
# periods).
#
# Neither check subsumes the other, which is why both exist.
#
# ## treat_missing_data
#
# The two alarms below are the only ones in this module that set
# `treat_missing_data = "breaching"`, and it is the whole point of them. Every
# other alarm here is watching for a bad value among good ones, where absent
# data honestly means "nothing bad happened". These two are watching for
# absence itself. If Route 53 stops publishing HealthCheckStatus — the health
# check was deleted, the metric is unavailable, the account lost the
# permission — then "we could not check" must not render as "checked and
# fine". It renders as ALARM.
#
# ## Region
#
# Route 53 publishes AWS/Route53 HealthCheckStatus into us-east-1 ONLY. The
# alarms must therefore live in us-east-1, and so must the SNS topic they
# notify, because CloudWatch cannot target a topic in another region. Both
# environments of this stack are us-east-1 (see environments/*/terraform.tfvars
# and backend.tf). The preconditions below say that out loud, so a region
# change fails the plan with an explanation instead of creating an alarm that
# silently cannot deliver.

locals {
  site_health_check_enabled = var.enable_site_health_check && var.site_health_check_host != ""
  api_health_check_enabled = (
    var.enable_api_health_check &&
    var.api_health_check_host != "" &&
    var.api_health_check_path != ""
  )

  # Shared by both preconditions below. Kept as a local so the two error
  # messages cannot drift apart from the condition they explain.
  alarms_can_read_route53 = data.aws_region.current.name == "us-east-1"

  route53_alarm_region_error = join(" ", [
    "Route 53 publishes AWS/Route53 HealthCheckStatus in us-east-1 only, and a CloudWatch alarm can only notify an SNS topic in its own region.",
    "This stack is deployed to ${data.aws_region.current.name}, so this alarm would either find no metric or be unable to reach ${aws_sns_topic.alerts.arn}.",
    "To run this stack outside us-east-1, give modules/monitoring an aws.us_east_1 provider alias, create the alerts topic (or a second one) there, and put these alarms on it.",
    "Until then set enable_site_health_check and enable_api_health_check to false — and note that with them off, nothing in this module can distinguish a total outage from a quiet hour (issue #464).",
  ])
}

# The site probe. Fetches a REAL PAGE, not `/`, and requires the response to
# contain a string only this app emits — because the outage that motivated
# this served a 403 from a CloudFront distribution that was itself perfectly
# healthy. "The CDN answered" is not the question; "the CDN answered with our
# app" is.
resource "aws_route53_health_check" "site" {
  count = local.site_health_check_enabled ? 1 : 0

  type          = "HTTPS_STR_MATCH"
  fqdn          = var.site_health_check_host
  port          = 443
  resource_path = var.site_health_check_path
  search_string = var.site_health_check_search_string

  # CloudFront serves this domain off a SNI certificate; without this the TLS
  # handshake fails and the check is unhealthy for the wrong reason.
  enable_sni = true

  # 30s is Route 53's normal interval (10s is available at +$1.00/month and
  # buys ~60 seconds of detection time, which is not worth it here).
  request_interval = 30

  # Three consecutive failures before the aggregate flips, so a single
  # checker's transient network blip cannot page. 3 x 30s = 90 seconds.
  failure_threshold = 3

  # +$1.00/month and this stack has no latency SLO that Route 53 would inform;
  # ApplicationLatency above is the latency signal.
  measure_latency = false

  tags = {
    Name = "${var.project_name}-site-${var.environment}"
  }
}

resource "aws_route53_health_check" "api" {
  count = local.api_health_check_enabled ? 1 : 0

  type              = "HTTPS_STR_MATCH"
  fqdn              = var.api_health_check_host
  port              = 443
  resource_path     = var.api_health_check_path
  search_string     = var.api_health_check_search_string
  enable_sni        = true
  request_interval  = 30
  failure_threshold = 3
  measure_latency   = false

  tags = {
    Name = "${var.project_name}-api-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "site_unreachable" {
  count = var.enable_alarms && local.site_health_check_enabled ? 1 : 0

  alarm_name          = "${var.project_name}-site-unreachable-${var.environment}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthCheckStatus"
  namespace           = "AWS/Route53"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "${var.site_health_check_host}${var.site_health_check_path} is not serving this application to Route 53's checkers, OR Route 53 stopped reporting on it. Either way nobody can use the site. This is the alarm for a total outage: check CloudFront, the frontend S3 bucket policy/OAC, and the most recent frontend deploy before anything else."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  # NOT "notBreaching", unlike every other alarm in this module. This alarm
  # exists to detect absence; if the signal itself goes absent, "we could not
  # check" must not be reported as "checked and fine". See the section header.
  treat_missing_data = "breaching"

  dimensions = {
    HealthCheckId = aws_route53_health_check.site[0].id
  }

  lifecycle {
    precondition {
      condition     = local.alarms_can_read_route53
      error_message = local.route53_alarm_region_error
    }
  }

  tags = {
    Name = "${var.project_name}-site-unreachable-alarm-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_unreachable" {
  count = var.enable_alarms && local.api_health_check_enabled ? 1 : 0

  alarm_name          = "${var.project_name}-api-unreachable-${var.environment}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthCheckStatus"
  namespace           = "AWS/Route53"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "GET ${var.api_health_check_path} is not answering ${var.api_health_check_search_string} to Route 53's checkers, OR Route 53 stopped reporting on it. The health route reports \"degraded\" when its DynamoDB probe fails, so this fires for a reachable-but-broken API too, not only for an unreachable one."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    HealthCheckId = aws_route53_health_check.api[0].id
  }

  lifecycle {
    precondition {
      condition     = local.alarms_can_read_route53
      error_message = local.route53_alarm_region_error
    }
  }

  tags = {
    Name = "${var.project_name}-api-unreachable-alarm-${var.environment}"
  }
}

# The companion to alarms_have_a_notification_destination above. That one
# catches "alarms exist but reach nobody"; this one catches "alarms exist,
# reach someone, and still cannot see the failure that matters most".
#
# A `check` rather than a precondition for the same reason as its sibling: it
# warns on every plan instead of blocking, so an environment can deliberately
# run without external probes — it just cannot do so quietly.
check "something_can_see_a_total_outage" {
  assert {
    condition     = !var.enable_alarms || local.site_health_check_enabled
    error_message = "The ${var.environment} stack creates CloudWatch alarms but no external site health check, so nothing in this module can tell 'serving nobody' from 'quiet': every alarm here uses treat_missing_data = \"notBreaching\". That is the exact state in which a forty-minute total frontend outage went unnoticed on 2026-09-04 (issue #464). Set enable_site_health_check = true with a site_health_check_host (~$2.60/month), or accept that the only thing standing between a total outage and a customer telling you about it is .github/workflows/uptime.yml — a 15-minute cron on GitHub's best-effort scheduler that reports by workflow-failure email."
  }
}
