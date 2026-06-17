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
  name              = "${var.project_name}-anomaly-${var.environment}"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "alerts" {
  count = var.alert_email == "" ? 0 : 1
  name  = "${var.project_name}-anomaly-sub-${var.environment}"
  # EMAIL subscribers only support DAILY/WEEKLY (IMMEDIATE needs an SNS topic).
  # DAILY = one digest email of the day's anomalies.
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

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

# CloudWatch Dashboard
#
# Layout (24-col grid):
#
#   ┌─────────────────┬─────────────────┐
#   │ API requests    │ API 4XX/5XX rate│   ← traffic + error health
#   ├─────────────────┼─────────────────┤
#   │ Lambda p95      │ DDB throttles   │   ← latency + capacity
#   ├─────────────────┼─────────────────┤
#   │ Lambda errors   │ Perenual budget │   ← failure + integration
#   └─────────────────┴─────────────────┘
#
# The four highest-value panels per the quality audit are:
#   1. Error rate (5XX/4XX)
#   2. p95 latency
#   3. Perenual daily budget consumed
#   4. DDB throttle count
# Lambda errors stay on as a backstop because surfaces with no API Gateway
# face (cron jobs, async handlers) only show up there.
resource "aws_cloudwatch_dashboard" "main" {
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
            ["AWS/ApiGateway", "Count", "ApiId", var.api_gateway_name]
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
          title  = "API Gateway error rate (4XX + 5XX)"
          region = data.aws_region.current.name
          # Two stacked series so 4XX (client) and 5XX (server) are
          # distinguishable at a glance — they imply very different actions.
          metrics = [
            ["AWS/ApiGateway", "5XXError", "ApiId", var.api_gateway_name, { stat = "Sum" }],
            [".", "4XXError", ".", ".", { stat = "Sum" }]
          ]
          period  = 300
          view    = "timeSeries"
          stacked = false
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Lambda p95 duration (ms)"
          region = data.aws_region.current.name
          # p95 is what users actually feel — averages hide tail problems.
          metrics = [
            for name in var.lambda_function_names : ["AWS/Lambda", "Duration", "FunctionName", name]
          ]
          period = 300
          stat   = "p95"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "DynamoDB throttled requests"
          region = data.aws_region.current.name
          # Read + write throttles on the single table. Any non-zero value
          # is a capacity issue worth investigating.
          metrics = var.dynamodb_table_name == "" ? [] : [
            ["AWS/DynamoDB", "ReadThrottleEvents", "TableName", var.dynamodb_table_name],
            [".", "WriteThrottleEvents", ".", "."]
          ]
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Lambda Errors"
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
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Perenual daily budget consumed"
          region = data.aws_region.current.name
          # Counts budget-exhausted events from the structured log emitted by
          # services/enrichment.ts. Spike = consider raising the daily budget
          # or moving to the paid Perenual tier.
          query = "SOURCE '/aws/lambda/${var.project_name}-${var.environment}' | filter msg = 'perenual.budget_exhausted' | stats count() by bin(5m)"
          view  = "timeSeries"
        }
      }
    ]
  })
}

data "aws_region" "current" {}

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
  critical_lambda_names = [
    for name in var.lambda_function_names : name
    if length(regexall("-(reminders|chat)-", name)) > 0
  ]
}

# Any Lambda error anywhere in the account/region. Coarse by design — the
# dashboard's per-function Errors widget gives the attribution.
resource "aws_cloudwatch_metric_alarm" "lambda_errors_aggregate" {
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

# Per-function alarms for the critical pair only (see strategy note above).
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = toset(local.critical_lambda_names)

  alarm_name          = "${each.value}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
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
  for_each = toset(local.critical_lambda_names)

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
  count = var.dynamodb_table_name == "" ? 0 : 1

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

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.project_name}-api-5xx-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5XXError"
  namespace           = "AWS/ApiGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "API Gateway 5XX errors exceeded threshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  # No 5XX metric published in a quiet window = no server errors = OK.
  treat_missing_data = "notBreaching"

  dimensions = {
    ApiId = var.api_gateway_name
  }

  tags = {
    Name = "${var.project_name}-api-5xx-alarm-${var.environment}"
  }
}

# --- Synthetic uptime monitor ---
# A Route53 health check continuously probes the public GET /health endpoint
# from AWS's global checker fleet — catching a hard outage (the API down) or a
# degraded state (the body no longer contains "status":"ok", e.g. DDB
# unreachable) even when no real user is hitting the app. Its metric
# (AWS/Route53 HealthCheckStatus) only publishes in us-east-1, which is also
# our primary region, so the alarm lives here too. Created only when an API
# endpoint is supplied.
resource "aws_route53_health_check" "api" {
  count = var.api_endpoint == "" ? 0 : 1

  # fqdn wants the bare host; api_endpoint is https://<host> with no path.
  fqdn              = replace(replace(var.api_endpoint, "https://", ""), "http://", "")
  port              = 443
  type              = "HTTPS_STR_MATCH"
  resource_path     = "/${var.environment}/health"
  search_string     = "\"status\":\"ok\""
  request_interval  = 30
  failure_threshold = 3

  tags = {
    Name = "${var.project_name}-api-health-${var.environment}"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_health" {
  count = var.api_endpoint == "" ? 0 : 1

  alarm_name          = "${var.project_name}-api-health-${var.environment}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HealthCheckStatus"
  namespace           = "AWS/Route53"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "Public /health endpoint is failing (unreachable, non-2xx, or status != ok)"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "breaching"

  dimensions = {
    HealthCheckId = aws_route53_health_check.api[0].id
  }

  tags = {
    Name = "${var.project_name}-api-health-alarm-${var.environment}"
  }
}

# Dead-letter queue depth. Any message here = an async invocation (the hourly
# reminders scan) failed past its retries and was dropped to the DLQ — silent
# data loss we want to know about immediately. treat_missing_data=notBreaching
# so a normally-empty queue (no metric emitted) doesn't false-alarm.
resource "aws_cloudwatch_metric_alarm" "lambda_dlq_depth" {
  count = var.lambda_dlq_name == "" ? 0 : 1

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

# Audit alarm: failed-login spike (possible credential stuffing / brute force).
# A metric filter turns the structured audit log line (pino JSON,
# `event: "auth.login.failure"`) on the auth Lambda's log group into a metric;
# the alarm pages when it spikes. The log group is Lambda-auto-created, so it
# must exist (the auth fn has run in prod) for the filter to apply.
resource "aws_cloudwatch_log_metric_filter" "auth_login_failure" {
  name           = "${var.project_name}-auth-login-failure-${var.environment}"
  log_group_name = "/aws/lambda/${var.project_name}-auth-${var.environment}"
  pattern        = "{ $.event = \"auth.login.failure\" }"

  metric_transformation {
    name          = "AuthLoginFailures"
    namespace     = "FamilyGreenhouse/Audit"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_login_failure_spike" {
  alarm_name          = "${var.project_name}-auth-login-failure-spike-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.auth_login_failure.metric_transformation[0].name
  namespace           = "FamilyGreenhouse/Audit"
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
