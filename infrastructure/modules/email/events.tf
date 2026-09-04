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

# Customer-managed key for the event topic, NOT the AWS-managed `alias/aws/sns`.
#
# Bounce payloads carry recipient addresses, so the topic is encrypted at rest.
# But SES publishes to it as a service principal, and SNS makes the KMS call on
# SES's behalf — which means the KEY policy (not just the topic policy) has to
# name ses.amazonaws.com. Without that, CreateConfigurationSetEventDestination
# is rejected outright:
#
#   BadRequestException: Access denied to KMS key for SNS topic
#   <...:family-greenhouse-email-events-production>. Verify the KMS key policy
#   grants Amazon SES the kms:GenerateDataKey and kms:Decrypt permissions.
#
# `alias/aws/sns` is an AWS-MANAGED key: its policy is owned by AWS and cannot
# be edited, so there is no way to add that statement to it. A customer-managed
# key is therefore the only shape this fix can take — it is not a preference.
#
# Scoping: this key is dedicated to this one topic and shared with nothing else,
# so the grant is confined by aws:SourceAccount, which stops another account's
# SES from using it (the confused-deputy case). A tighter aws:SourceArn /
# kms:EncryptionContext condition is only worth adding if this key ever starts
# encrypting something besides this topic, and would need validating against a
# real apply first — SES does not document which of those keys it populates on
# the KMS call, and a condition it does not populate would reproduce the exact
# BadRequestException above.
resource "aws_kms_key" "email_events" {
  description         = "SSE for the ${var.project_name} SES event topic (${var.environment}). Bounce/complaint payloads carry recipient addresses."
  enable_key_rotation = true
  # Long window: a deleted key makes every message still on the topic
  # undecryptable, and this key is cheap to keep.
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.email_events_kms.json

  tags = {
    Name = "${var.project_name}-email-events-${var.environment}"
  }
}

resource "aws_kms_alias" "email_events" {
  name          = "alias/${var.project_name}-email-events-${var.environment}"
  target_key_id = aws_kms_key.email_events.key_id
}

data "aws_iam_policy_document" "email_events_kms" {
  # Without this the key is unmanageable: KMS does not fall back to IAM, so a
  # key policy that omits the account locks out every principal including the
  # Terraform role that created it. This is the AWS default root statement — it
  # delegates to IAM, it does not widen access beyond this account.
  statement {
    sid    = "EnableAccountAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # The statement the CreateConfigurationSetEventDestination error asks for.
  # GenerateDataKey* rather than GenerateDataKey so the
  # GenerateDataKeyWithoutPlaintext variant is covered too.
  statement {
    sid    = "AllowSESToEncryptEventsForThisTopic"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    actions = [
      "kms:GenerateDataKey*",
      "kms:Decrypt",
    ]

    resources = ["*"]

    # Confused-deputy guard: only THIS account's SES may use the key.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic" "email_events" {
  name = "${var.project_name}-email-events-${var.environment}"
  # SSE with the module's own CMK. Bounce payloads carry recipient addresses.
  # See aws_kms_key.email_events for why this cannot be alias/aws/sns.
  kms_master_key_id = aws_kms_key.email_events.arn

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
