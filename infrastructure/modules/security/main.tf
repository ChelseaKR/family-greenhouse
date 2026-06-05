# WAF Web ACL for API Gateway
resource "aws_wafv2_web_acl" "api" {
  name        = "${var.project_name}-api-waf-${var.environment}"
  description = "WAF for API Gateway"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # Rate limiting. Note: `rate_based_statement` requires `action`, not
  # `override_action` (the latter is only valid for managed rule groups).
  rule {
    name     = "RateLimitRule"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - Common
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        rule_action_override {
          action_to_use {
            count {}
          }
          name = "SizeRestrictions_BODY"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - Known Bad Inputs
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed Rules - SQL Injection
  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 4

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-sqli"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}-api-waf"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "${var.project_name}-api-waf-${var.environment}"
  }
}

# WAF Logging
resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${var.project_name}-${var.environment}"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-waf-logs-${var.environment}"
  }
}

resource "aws_wafv2_web_acl_logging_configuration" "api" {
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  resource_arn            = aws_wafv2_web_acl.api.arn
}

# NOTE: WAFv2 CANNOT be associated with an API Gateway *HTTP* API (v2).
# AWS WAF supports REST API stages, ALB, CloudFront, AppSync, Cognito, and App
# Runner — but not apigatewayv2 HTTP APIs: AssociateWebACL rejects the
# `/apis/<id>/stages/<stage>` ARN with WAFInvalidParameterException. (An earlier
# attempt to associate it here failed in production for exactly this reason.)
#
# The regional web ACL above is retained but unassociated. To actually enforce
# it, front the HTTP API with CloudFront and attach a CLOUDFRONT-scoped ACL
# there, or migrate the API to a REST API. Until then, edge protection relies on
# the CloudFront WAF (frontend module) + the API's stage-level throttling.
