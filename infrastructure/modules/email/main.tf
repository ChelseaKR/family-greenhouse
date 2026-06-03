# SES domain identity for sending branded outbound mail (Cognito confirmations,
# reminders, password resets, transactional Stripe receipts).
#
# Two things to keep in mind:
#
# 1. The account starts in the SES sandbox: you can only send to *verified*
#    addresses and at most 200/day. Production-grade sending needs a sandbox-
#    exit support ticket to AWS (24-48hr turnaround). The Terraform here is
#    correct for sandbox or production — the ticket just lifts the cap.
#
# 2. DKIM alignment makes deliverability work. Without it the messages will
#    land in spam regardless of how the body looks. SPF alignment would be
#    nice-to-have but needs a custom MAIL FROM domain; DKIM alone is sufficient
#    for DMARC `p=quarantine` to pass.

data "aws_route53_zone" "primary" {
  name         = var.domain_name
  private_zone = false
}

resource "aws_ses_domain_identity" "main" {
  domain = var.domain_name
}

# The DNS verification token. SES checks _amazonses.<domain> for this TXT.
resource "aws_route53_record" "verification" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "_amazonses.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.main.verification_token]
}

resource "aws_ses_domain_identity_verification" "main" {
  domain     = aws_ses_domain_identity.main.id
  depends_on = [aws_route53_record.verification]
}

# DKIM: three keys, each a CNAME to amazonses.com. Aligns with the From: domain
# so DMARC's DKIM check passes for receivers like Gmail/Outlook.
resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "${aws_ses_domain_dkim.main.dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.main.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# SPF. Without a custom MAIL FROM domain the Return-Path aligns with
# amazonses.com (so SPF won't DMARC-align), but the record still helps
# receivers verify outbound mail belongs to SES.
resource "aws_route53_record" "spf" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# DMARC. Start at `p=quarantine` so misaligned mail goes to spam rather than
# being rejected outright; tighten to `p=reject` once deliverability is
# stable and you've watched the rua reports for a couple of weeks.
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [
    "v=DMARC1; p=quarantine; rua=mailto:${coalesce(var.dmarc_rua_email, "dmarc@${var.domain_name}")}; fo=1; aspf=r; adkim=r"
  ]
}

# Grant the Cognito service principal permission to send mail from this
# identity. Without this policy, Cognito's DEVELOPER email mode can't use the
# identity and confirmations silently fall back to the default sender.
data "aws_caller_identity" "current" {}

resource "aws_ses_identity_policy" "cognito" {
  identity = aws_ses_domain_identity.main.arn
  name     = "${var.project_name}-cognito-send-${var.environment}"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCognitoToSendEmail"
        Effect = "Allow"
        Principal = {
          Service = "cognito-idp.amazonaws.com"
        }
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
        ]
        Resource = aws_ses_domain_identity.main.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}
