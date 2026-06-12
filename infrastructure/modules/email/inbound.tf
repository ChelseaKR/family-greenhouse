# Inbound mail for the domain: MX -> SES receiving -> S3 (raw MIME) -> Lambda
# forward to the maintainer's real mailbox. Before this existed, support@ /
# security@ / hello@ / dmarc@ were advertised (tfvars, SECURITY.md, DMARC rua)
# but were black holes — the domain had no MX record at all.
#
# The forward DESTINATION deliberately lives in Secrets Manager
# (family-greenhouse/inbound-forward-address, created via the AWS CLI — same
# convention as the Perenual key) so a personal address never appears in git.
#
# SES inbound is only offered in a few regions; us-east-1 (this stack's
# region) is one of them. Receipt-rule-set activation is ACCOUNT-WIDE per
# region — fine here, nothing else in the account receives mail.

# (data.aws_caller_identity.current is declared in main.tf)
data "aws_region" "current" {}

data "aws_secretsmanager_secret_version" "inbound_forward" {
  secret_id = "family-greenhouse/inbound-forward-address"
}

locals {
  inbound_mailboxes = ["support", "security", "hello", "dmarc"]
  inbound_recipients = [
    for box in local.inbound_mailboxes : "${box}@${var.domain_name}"
  ]
  forwarder_from = "forwarder@${var.domain_name}"
}

resource "aws_route53_record" "mx" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = var.domain_name
  type    = "MX"
  ttl     = 600
  records = ["10 inbound-smtp.${data.aws_region.current.name}.amazonaws.com"]
}

# --- Raw mail storage -------------------------------------------------------

resource "aws_s3_bucket" "inbound_mail" {
  bucket = "${var.project_name}-inbound-mail-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.project_name}-inbound-mail-${var.environment}"
  }
}

resource "aws_s3_bucket_public_access_block" "inbound_mail" {
  bucket                  = aws_s3_bucket.inbound_mail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbound_mail" {
  bucket = aws_s3_bucket.inbound_mail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Mail is forwarded within seconds; the S3 copy is a 90-day safety net for
# forwarding failures, then it expires.
resource "aws_s3_bucket_lifecycle_configuration" "inbound_mail" {
  bucket = aws_s3_bucket.inbound_mail.id
  rule {
    id     = "expire-mail"
    status = "Enabled"
    filter {
      prefix = "inbox/"
    }
    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_policy" "inbound_mail" {
  bucket = aws_s3_bucket.inbound_mail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSESPuts"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.inbound_mail.arn}/*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

# --- Forwarder Lambda -------------------------------------------------------

data "archive_file" "forwarder" {
  type        = "zip"
  source_file = "${path.module}/lambda/forwarder.mjs"
  output_path = "${path.module}/lambda/forwarder.zip"
}

resource "aws_iam_role" "forwarder" {
  name = "${var.project_name}-mail-forwarder-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "forwarder" {
  name = "${var.project_name}-mail-forwarder-${var.environment}"
  role = aws_iam_role.forwarder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.inbound_mail.arn}/*"
      },
      {
        # identity/* (account-scoped), not just the domain identity: while the
        # account is in the SES sandbox, sends are ALSO authorized against the
        # recipient's verified-identity ARN (the forward destination is a
        # verified address), and denying that breaks forwarding with
        # "not authorized to perform ses:SendRawEmail on identity/<dest>".
        Effect   = "Allow"
        Action   = ["ses:SendRawEmail"]
        Resource = "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:identity/*"
      },
    ]
  })
}

resource "aws_lambda_function" "forwarder" {
  function_name    = "${var.project_name}-mail-forwarder-${var.environment}"
  role             = aws_iam_role.forwarder.arn
  handler          = "forwarder.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 256
  filename         = data.archive_file.forwarder.output_path
  source_code_hash = data.archive_file.forwarder.output_base64sha256

  environment {
    variables = {
      MAIL_BUCKET  = aws_s3_bucket.inbound_mail.bucket
      MAIL_PREFIX  = "inbox/"
      FORWARD_TO   = data.aws_secretsmanager_secret_version.inbound_forward.secret_string
      FROM_ADDRESS = local.forwarder_from
    }
  }

  tags = {
    Name = "${var.project_name}-mail-forwarder-${var.environment}"
  }
}

resource "aws_cloudwatch_log_group" "forwarder" {
  name              = "/aws/lambda/${aws_lambda_function.forwarder.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "ses_invoke" {
  statement_id  = "AllowSESInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.forwarder.function_name
  principal     = "ses.amazonaws.com"
  # source_arn is built by hand instead of referencing the rule resource:
  # SES validates invoke permission AT rule creation, so the permission must
  # exist first and a resource reference would be a dependency cycle. The
  # receipt-rule ARN format is stable and the rule name is fixed below.
  source_account = data.aws_caller_identity.current.account_id
  source_arn     = "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:receipt-rule-set/${aws_ses_receipt_rule_set.main.rule_set_name}:receipt-rule/forward-to-maintainer"
}

# --- Receipt rules ----------------------------------------------------------

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "${var.project_name}-${var.environment}"
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}

resource "aws_ses_receipt_rule" "forward" {
  name          = "forward-to-maintainer"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = local.inbound_recipients
  enabled       = true
  scan_enabled  = true # SES spam/virus verdicts recorded in headers

  s3_action {
    bucket_name       = aws_s3_bucket.inbound_mail.bucket
    object_key_prefix = "inbox/"
    position          = 1
  }

  lambda_action {
    function_arn    = aws_lambda_function.forwarder.arn
    invocation_type = "Event"
    position        = 2
  }

  depends_on = [
    aws_s3_bucket_policy.inbound_mail,
    aws_lambda_permission.ses_invoke,
  ]
}
