# Outbound-mail feedback loop: SES configuration set -> SNS -> the emailEvents
# Lambda (subscribed in modules/api, which owns the backend functions).
#
# Before this existed there was no configuration set anywhere in the stack and
# therefore no bounce or complaint destination at all. Nothing in the product
# ever learned that an address was dead: a member's email is written once at
# join time and the weekly digest re-sent to it forever. Sustained bounces are
# what cost a domain its sending reputation, and that reputation is shared by
# every message the domain sends — password resets included.
#
# The topic lives here (with the identity it reports on) while the subscription
# lives in modules/api (with the function it delivers to). Splitting it that way
# is what keeps `email -> api` a straight line instead of a dependency cycle.

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = "${var.project_name}-${var.environment}"

  delivery_options {
    # OPTIONAL, not REQUIRE. SES already uses opportunistic TLS; REQUIRE makes
    # SES refuse to deliver to a receiver that cannot negotiate TLS, which
    # turns a receiver's misconfiguration into our silent non-delivery. The
    # threat model here is a family plant-care reminder, not a wire secret.
    tls_policy = "OPTIONAL"
  }

  reputation_options {
    # Per-configuration-set bounce/complaint rates in CloudWatch. Without this
    # the only reputation numbers available are account-wide.
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    # SES's OWN account-level suppression list, scoped to this configuration
    # set. Belt to the application list's braces: if a send somehow reaches SES
    # for an address SES has already seen bounce, SES drops it rather than
    # re-bouncing it. The application list is still the source of truth the
    # product can read, explain, and let a user clear.
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  tags = {
    Name = "${var.project_name}-email-events-${var.environment}"
  }
}

resource "aws_sns_topic" "email_events" {
  name = "${var.project_name}-email-events-${var.environment}"
  # SSE with the AWS-managed SNS key. Bounce payloads carry recipient addresses.
  kms_master_key_id = "alias/aws/sns"

  tags = {
    Name = "${var.project_name}-email-events-${var.environment}"
  }
}

data "aws_iam_policy_document" "email_events_topic" {
  statement {
    sid    = "AllowSESPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.email_events.arn]

    # Scope to this account so another account's SES cannot publish here.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "email_events" {
  arn    = aws_sns_topic.email_events.arn
  policy = data.aws_iam_policy_document.email_events_topic.json
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "${var.project_name}-sns-${var.environment}"

  event_destination {
    enabled = true

    # BOUNCE and COMPLAINT drive suppression. DELIVERY is what CLEARS a
    # transient soft-bounce counter — without it a mailbox that was full for a
    # week would keep its strikes forever. REJECT and RENDERING_FAILURE are
    # carried so a send SES refused outright shows up in the logs instead of
    # looking like a success. DELIVERY_DELAY is the "still trying" signal that
    # must NOT be counted as either.
    matching_event_types = [
      "BOUNCE",
      "COMPLAINT",
      "DELIVERY",
      "DELIVERY_DELAY",
      "REJECT",
      "RENDERING_FAILURE",
    ]

    sns_destination {
      topic_arn = aws_sns_topic.email_events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.email_events]
}
