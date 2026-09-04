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
#    land in spam regardless of how the body looks. SPF alignment additionally
#    needs a custom MAIL FROM domain, which `aws_ses_domain_mail_from` below
#    now provides — so DMARC no longer rests on DKIM alone. See ADR 0022.

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

# --- Custom MAIL FROM domain ---------------------------------------------
#
# The envelope sender (Return-Path / SMTP MAIL FROM) is what SPF authenticates.
# Without this block SES uses its own `*.amazonses.com` bounce domain, so the
# apex SPF record below authenticates a domain that ISN'T the From: domain and
# therefore cannot satisfy DMARC's SPF alignment. DKIM alone carried DMARC.
#
# One authentication mechanism is one bad day away from zero. A DKIM key that
# gets rotated wrong, a forwarder that rewrites the body, a receiver that
# happens to weight SPF — any of those turns "quarantine" from a policy into an
# outage on password-reset mail. With this block the Return-Path becomes
# `mail.<domain>`, an organizational-domain match for the From:, so SPF aligns
# under the relaxed policy (`aspf=r`) and BOTH mechanisms carry DMARC.
#
# `behavior_on_mx_failure = "UseDefaultValue"` is the deliberate choice: if the
# MX below is not resolvable (DNS not yet propagated, a zone edit gone wrong),
# SES silently falls back to its own bounce domain instead of REFUSING TO SEND.
# `RejectMessage` would turn a DNS hiccup into a total mail outage, and the
# fallback state is exactly today's behaviour — worse than aligned, no worse
# than before.
locals {
  mail_from_domain = "${var.mail_from_subdomain}.${var.domain_name}"
}

resource "aws_ses_domain_mail_from" "main" {
  domain                 = aws_ses_domain_identity.main.domain
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "UseDefaultValue"
}

# Bounce/complaint feedback for the MAIL FROM subdomain has to route back to
# SES, which is what this MX is for. NOTE this is a DIFFERENT record from the
# apex MX in inbound.tf: that one points at `inbound-smtp` and delivers mail to
# the receipt rules (support@, security@ ...); this one points at
# `feedback-smtp` and exists only to receive bounce notifications for the
# envelope sender. Neither replaces the other and they never share a name.
resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${data.aws_region.current.name}.amazonses.com"]
}

# SPF for the MAIL FROM subdomain itself. This is the record receivers actually
# evaluate for SPF once the Return-Path moves here; the apex record below stays
# for receivers that check the header-From domain.
resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# Apex TXT record. Holds TWO things because both live at the zone apex as TXT
# and must therefore share one record set:
#   1. The SES SPF policy. The Return-Path now aligns to the MAIL FROM
#      subdomain above (whose own SPF record is the one receivers evaluate),
#      so this apex record covers anything checking the header-From domain and
#      anything sent before the MAIL FROM change propagates.
#   2. The Google Search Console domain-verification token. Managed here (not
#      just via a one-off CLI change) so a terraform apply can't silently drop
#      it and un-verify Search Console. Site-verification tokens are public, so
#      it's fine in source.
resource "aws_route53_record" "spf" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 600
  records = [
    "v=spf1 include:amazonses.com ~all",
    "google-site-verification=cE-VHXfwES1qyQGDQ4S6gLFE4mxlCPo4IYVA1NZW8c0",
  ]
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
