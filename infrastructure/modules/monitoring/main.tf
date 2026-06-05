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
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = toset(var.lambda_function_names)

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

  dimensions = {
    FunctionName = each.value
  }

  tags = {
    Name = "${each.value}-errors-alarm"
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  for_each = toset(var.lambda_function_names)

  alarm_name          = "${each.value}-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  threshold           = 10000 # 10 seconds
  alarm_description   = "Lambda function ${each.value} duration exceeded threshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]

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

  dimensions = {
    ApiId = var.api_gateway_name
  }

  tags = {
    Name = "${var.project_name}-api-5xx-alarm-${var.environment}"
  }
}
