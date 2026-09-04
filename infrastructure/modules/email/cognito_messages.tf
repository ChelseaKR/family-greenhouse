# Branded Cognito messages for the paths a declarative template cannot reach.
#
# `verification_message_template` (modules/auth) covers sign-up confirmation.
# Forgot-password has no equivalent field, so it shipped AWS's stock body from
# the same From: address as the hand-written sign-up email — a jarring identity
# break on the one email a locked-out user must trust. The CustomMessage
# trigger is the mechanism Cognito provides for it.
#
# It lives in THIS module rather than in modules/auth for two reasons: the
# bodies are email templates, which is what this module is for, and this module
# already has the `aws.iam` provider alias the execution role needs (the default
# provider's case-duplicated cost tags are rejected by IAM CreateRole — see the
# root main.tf comment). The user pool consumes it by ARN, and the invoke
# permission is granted next to the pool in modules/auth, so the dependency
# stays one-way: email -> auth.

data "archive_file" "cognito_messages" {
  type        = "zip"
  source_file = "${path.module}/lambda/cognitoMessages.mjs"
  output_path = "${path.module}/lambda/cognitoMessages.zip"
}

resource "aws_iam_role" "cognito_messages" {
  provider = aws.iam

  name = "${var.project_name}-cognito-messages-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# Logs only. The trigger renders a string from the event it is handed; it reads
# nothing and writes nothing.
resource "aws_iam_role_policy" "cognito_messages" {
  name = "${var.project_name}-cognito-messages-${var.environment}"
  role = aws_iam_role.cognito_messages.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:aws:logs:*:*:*"
    }]
  })
}

resource "aws_lambda_function" "cognito_messages" {
  function_name    = "${var.project_name}-cognito-messages-${var.environment}"
  role             = aws_iam_role.cognito_messages.arn
  handler          = "cognitoMessages.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  timeout          = 5
  memory_size      = 128
  filename         = data.archive_file.cognito_messages.output_path
  source_code_hash = data.archive_file.cognito_messages.output_base64sha256

  environment {
    variables = {
      SITE_URL = "https://${var.domain_name}"
      # Named in the sign-off so a reply-to-the-robot has somewhere to land.
      # Already forwarded to a human by inbound.tf.
      SUPPORT_EMAIL = "support@${var.domain_name}"
    }
  }

  tags = {
    Name = "${var.project_name}-cognito-messages-${var.environment}"
  }
}

resource "aws_cloudwatch_log_group" "cognito_messages" {
  name              = "/aws/lambda/${aws_lambda_function.cognito_messages.function_name}"
  retention_in_days = 30
}
