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
# request/error panels deliberately exclude GET /health so the 30-second
# synthetic probe cannot swamp the two real users' traffic or error rate.
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

resource "aws_cloudwatch_metric_alarm" "dynamodb_write_throttle" {
  count = var.dynamodb_table_name == "" ? 0 : 1

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

# Inbound-mail forwarder DLQ depth. Any message here = a forward (security@ /
# abuse@ / support@ mail) failed past its async retries and was dead-lettered —
# silent loss of mail we explicitly want to see. Separate from lambda_dlq_depth
# (the reminders DLQ) because the email module owns its own queue and is only
# created when a domain is configured. treat_missing_data = notBreaching so a
# normally-empty queue doesn't false-alarm.
resource "aws_cloudwatch_metric_alarm" "email_forwarder_dlq_depth" {
  count = var.email_forwarder_dlq_name == "" ? 0 : 1

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
