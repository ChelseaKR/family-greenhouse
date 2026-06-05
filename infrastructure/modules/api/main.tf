# API Gateway
resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [var.allowed_origin]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    # X-Household-Id pins a non-default household per request (see
    # docs/multi-household.md). X-Cognito-Access-Token carries the Cognito
    # access token alongside the ID token for Cognito-direct calls (see
    # docs/security-review-2026-05-31.md token-split fix). Both must be
    # declared here or strict browsers (Safari, Firefox) reject the
    # preflight before the request reaches Lambda — failure mode is a
    # silent CORS block with no log on our side.
    allow_headers     = ["Content-Type", "Authorization", "X-Household-Id", "X-Cognito-Access-Token"]
    allow_credentials = true
    max_age           = 300
  }

  tags = {
    Name = "${var.project_name}-api-${var.environment}"
  }
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = var.environment
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      errorMessage   = "$context.error.message"
    })
  }

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${var.project_name}-${var.environment}"
  retention_in_days = 30
}

# Cognito Authorizer
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito"

  jwt_configuration {
    audience = [var.cognito_client_id]
    issuer   = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${var.cognito_user_pool_id}"
  }
}

data "aws_region" "current" {}

# Lambda IAM Role
resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-lambda-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${var.project_name}-lambda-policy-${var.environment}"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          var.dynamodb_table_arn,
          "${var.dynamodb_table_arn}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject"
        ]
        Resource = "${var.images_bucket_arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes"
        ]
        Resource = "arn:aws:cognito-idp:*:*:userpool/${var.cognito_user_pool_id}"
      },
      {
        # Reminder + notification delivery (email via SES, SMS via SNS). Web
        # push needs no IAM (VAPID over HTTPS). Scoped broadly here; tighten to
        # the verified SES identity / SNS topic ARNs once those are provisioned.
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "sns:Publish"
        ]
        Resource = "*"
      },
      {
        # Bedrock for the chat handler. Two ARN shapes are needed:
        #   - The foundation-model ARN (the underlying Claude or Titan
        #     weights) is global (no account in the ARN).
        #   - The inference-profile ARN is account-scoped. Newer Claude
        #     families (Sonnet 4.5+, Opus 4.5+, Haiku 4.5+) on Bedrock
        #     can ONLY be invoked through an inference profile — direct
        #     foundation-model invocation returns ValidationException.
        # AWS requires the caller to hold permission on BOTH the profile
        # ARN and the underlying FM ARNs.
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
          "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-*",
          "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-*",
          "arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-*",
        ]
      },
      {
        # Read-only access to Secrets Manager values under the
        # `family-greenhouse/*` prefix. Used by services that fetch
        # credentials at Lambda cold start (Perenual today; Stripe + VAPID
        # + Sentry will migrate the same way). The trailing `-??????` on
        # the ARN matches the 6-character suffix Secrets Manager appends
        # at creation.
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          "arn:aws:secretsmanager:*:*:secret:family-greenhouse/*",
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_xray" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Lambda Functions
locals {
  # One Lambda per handler group; the bundle name (esbuild output) matches the
  # key. Each group's `handler` export dispatches its routes (see
  # backend/src/middleware/router.ts).
  lambda_handlers = {
    "auth"          = "auth"
    "plants"        = "plants"
    "tasks"         = "tasks"
    "households"    = "households"
    "me"            = "me"
    "notifications" = "notifications"
    "billing"       = "billing"
    "species"       = "species"
    "climate"       = "climate"
    "apiKeys"       = "apiKeys"
    "api"           = "api"
    # Not an HTTP group — invoked by EventBridge (see the schedule below). It
    # gets an unused API integration/permission from the for_each, which is
    # harmless since no route targets it.
    "reminders" = "reminders"
    # Bedrock-backed plant care chatbot. Memory + timeout are higher than the
    # default because a turn can run up to 5 tool calls, each one a Bedrock
    # InvokeModel that takes 2-6 seconds.
    "chat" = "chat"
  }
}

resource "aws_lambda_function" "handlers" {
  for_each = local.lambda_handlers

  function_name = "${var.project_name}-${each.key}-${var.environment}"
  role          = aws_iam_role.lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  # `chat` runs Bedrock InvokeModel up to 5 times per turn (Sonnet 4.6 latency
  # ~2-6s per call), and the tool-use loop can occasionally push past 30s.
  # 90s leaves margin without unbounded; memory bump shortens cold starts.
  timeout     = each.key == "chat" ? 90 : 30
  memory_size = each.key == "chat" ? 512 : 256

  filename         = "${path.module}/placeholder.zip"
  source_code_hash = filebase64sha256("${path.module}/placeholder.zip")

  environment {
    variables = {
      NODE_ENV             = var.environment
      TABLE_NAME           = var.dynamodb_table_name
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
      COGNITO_CLIENT_ID    = var.cognito_client_id
      IMAGES_BUCKET        = var.images_bucket_name
      ALLOWED_ORIGIN       = var.allowed_origin
      # FRONTEND_URL is the user-facing URL the invite + checkout flows
      # use to build links. Same value as ALLOWED_ORIGIN today; kept as a
      # separate var so a future split (e.g. checkout-success URL on a
      # different subdomain) is a tfvars change, not a code change.
      FRONTEND_URL = var.allowed_origin
      # Bedrock chat model. Defaults set in code (Haiku 4.5); pin via
      # tfvar to swap to Sonnet/Opus without a redeploy.
      BEDROCK_CHAT_MODEL_ID       = var.bedrock_chat_model_id
      BEDROCK_INPUT_USD_PER_MTOK  = var.bedrock_input_usd_per_mtok
      BEDROCK_OUTPUT_USD_PER_MTOK = var.bedrock_output_usd_per_mtok
      # Source maps in stack traces: esbuild already emits them; this flag
      # tells Node 20 to actually use them when printing CloudWatch errors.
      NODE_OPTIONS = "--enable-source-maps"
      # Stripe + SES + VAPID + Plant.id + Sentry: declared here so the
      # `terraform apply` surface is the single source of truth for what
      # env reaches the Lambda. Empty strings let the code fall through to
      # its baked-in default or fail-fast behavior. Migrate to Secrets
      # Manager when first real credentials land.
      STRIPE_SECRET_KEY          = var.stripe_secret_key
      STRIPE_WEBHOOK_SECRET      = var.stripe_webhook_secret
      STRIPE_PRICE_ID_GARDEN     = var.stripe_price_id_garden
      STRIPE_PRICE_ID_GREENHOUSE = var.stripe_price_id_greenhouse
      SES_FROM_EMAIL             = var.ses_from_email
      WEB_PUSH_VAPID_PUBLIC_KEY  = var.web_push_vapid_public_key
      WEB_PUSH_VAPID_PRIVATE_KEY = var.web_push_vapid_private_key
      WEB_PUSH_VAPID_SUBJECT     = var.web_push_vapid_subject
      SMS_NOTIFICATIONS_ENABLED  = var.sms_notifications_enabled
      PLANT_ID_API_KEY           = var.plant_id_api_key
      # OpenWeather powers the climate/weather features. Without the key the
      # weather service short-circuits to null and those features silently
      # disable in prod — so it must be wired here, not left to drift.
      OPENWEATHER_API_KEY      = var.openweather_api_key
      OPENWEATHER_DAILY_BUDGET = var.openweather_daily_budget
      # Perenual key is held in Secrets Manager (runtime fetch). Pass the
      # SECRET NAME, not the value — the value never reaches Terraform state.
      PERENUAL_API_KEY_SECRET_ID = var.perenual_api_key_secret_id
      PERENUAL_DAILY_BUDGET      = var.perenual_daily_budget
      # Bedrock embedding model for the chat RAG corpus. Empty lets the code
      # default to amazon.titan-embed-text-v2:0.
      BEDROCK_EMBED_MODEL_ID    = var.bedrock_embed_model_id
      SENTRY_DSN                = var.sentry_dsn
      SENTRY_TRACES_SAMPLE_RATE = var.sentry_traces_sample_rate
      GIT_SHA                   = var.git_sha
      CHAT_BUDGET_INPUT_TOKENS  = var.chat_budget_input_tokens
      CHAT_BUDGET_OUTPUT_TOKENS = var.chat_budget_output_tokens
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = {
    Name = "${var.project_name}-${each.key}-${var.environment}"
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.lambda_handlers

  name              = "/aws/lambda/${var.project_name}-${each.key}-${var.environment}"
  retention_in_days = 30
}

# Lambda Permissions for API Gateway
resource "aws_lambda_permission" "api_gateway" {
  for_each = local.lambda_handlers

  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handlers[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# API Routes
resource "aws_apigatewayv2_integration" "handlers" {
  for_each = local.lambda_handlers

  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.handlers[each.key].invoke_arn
  payload_format_version = "2.0"
}

# All API routes — one per endpoint. API Gateway matches the route and sets
# `event.routeKey`; each group's Lambda `handler` dispatches on it (see
# backend/src/middleware/router.ts). `auth = "jwt"` attaches the Cognito JWT
# authorizer; "none" is either genuinely public (pre-login /auth/*, the Stripe
# webhook, the public plans endpoint) or API-key-authenticated inside the
# handler (/api/v1/*). The handlers enforce auth themselves, so a wrong flag
# fails closed (401/locked), never open.
locals {
  routes = {
    # --- auth (public except authenticated profile/password) ---
    "POST /auth/signup"          = { group = "auth", auth = "none" }
    "POST /auth/resend-code"     = { group = "auth", auth = "none" }
    "POST /auth/confirm"         = { group = "auth", auth = "none" }
    "POST /auth/login"           = { group = "auth", auth = "none" }
    "POST /auth/refresh"         = { group = "auth", auth = "none" }
    "POST /auth/forgot-password" = { group = "auth", auth = "none" }
    "POST /auth/reset-password"  = { group = "auth", auth = "none" }
    "POST /auth/change-password" = { group = "auth", auth = "jwt" }
    "GET /auth/me"               = { group = "auth", auth = "jwt" }
    "PATCH /auth/me"             = { group = "auth", auth = "jwt" }

    # --- plants ---
    "GET /plants"                     = { group = "plants", auth = "jwt" }
    "POST /plants"                    = { group = "plants", auth = "jwt" }
    "GET /plants/{id}"                = { group = "plants", auth = "jwt" }
    "PUT /plants/{id}"                = { group = "plants", auth = "jwt" }
    "DELETE /plants/{id}"             = { group = "plants", auth = "jwt" }
    "POST /plants/{id}/image"         = { group = "plants", auth = "jwt" }
    "POST /plants/{id}/image/confirm" = { group = "plants", auth = "jwt" }
    "GET /plants/{id}/photos"         = { group = "plants", auth = "jwt" }
    "GET /plants/{plantId}/history"   = { group = "plants", auth = "jwt" }
    "POST /plants/identify"           = { group = "plants", auth = "jwt" }

    # --- tasks (templates list is public) ---
    "GET /tasks"                            = { group = "tasks", auth = "jwt" }
    "GET /tasks/upcoming"                   = { group = "tasks", auth = "jwt" }
    "POST /tasks"                           = { group = "tasks", auth = "jwt" }
    "GET /tasks/{id}"                       = { group = "tasks", auth = "jwt" }
    "PUT /tasks/{id}"                       = { group = "tasks", auth = "jwt" }
    "DELETE /tasks/{id}"                    = { group = "tasks", auth = "jwt" }
    "POST /tasks/{id}/complete"             = { group = "tasks", auth = "jwt" }
    "GET /tasks/templates"                  = { group = "tasks", auth = "none" }
    "POST /plants/apply-template-bulk"      = { group = "tasks", auth = "jwt" }
    "POST /plants/{plantId}/apply-template" = { group = "tasks", auth = "jwt" }
    "POST /tasks/{id}/snooze"               = { group = "tasks", auth = "jwt" }

    # --- households (invite preview is public) ---
    "POST /households"                                    = { group = "households", auth = "jwt" }
    "GET /households/{id}"                                = { group = "households", auth = "jwt" }
    "POST /households/{id}/invites"                       = { group = "households", auth = "jwt" }
    "GET /households/invites/{inviteCode}"                = { group = "households", auth = "none" }
    "POST /households/join/{inviteCode}"                  = { group = "households", auth = "jwt" }
    "GET /households/{id}/activity"                       = { group = "households", auth = "jwt" }
    "GET /households/{id}/analytics/daily"                = { group = "households", auth = "jwt" }
    "GET /households/{id}/year-in-review"                 = { group = "households", auth = "jwt" }
    "PUT /households/{householdId}/members/{userId}/role" = { group = "households", auth = "jwt" }
    "DELETE /households/{householdId}/members/{userId}"   = { group = "households", auth = "jwt" }

    # --- me ---
    "DELETE /me"           = { group = "me", auth = "jwt" }
    "GET /me/export"       = { group = "me", auth = "jwt" }
    "GET /me/households"   = { group = "me", auth = "jwt" }
    "GET /me/calendar.ics" = { group = "me", auth = "jwt" }

    # --- notifications ---
    "GET /notifications/prefs"          = { group = "notifications", auth = "jwt" }
    "PUT /notifications/prefs"          = { group = "notifications", auth = "jwt" }
    "POST /notifications/subscribe"     = { group = "notifications", auth = "jwt" }
    "POST /notifications/unsubscribe"   = { group = "notifications", auth = "jwt" }
    "POST /notifications/run-reminders" = { group = "notifications", auth = "jwt" }

    # --- billing (plans + webhook public; webhook is Stripe-signed) ---
    "GET /billing/plans"     = { group = "billing", auth = "none" }
    "GET /billing/me"        = { group = "billing", auth = "jwt" }
    "POST /billing/checkout" = { group = "billing", auth = "jwt" }
    "POST /billing/portal"   = { group = "billing", auth = "jwt" }
    "POST /billing/webhook"  = { group = "billing", auth = "none" }

    # --- species ---
    "GET /species/search"                = { group = "species", auth = "jwt" }
    "GET /species/{id}"                  = { group = "species", auth = "jwt" }
    "GET /species/{id}/thumbnail"        = { group = "species", auth = "jwt" }
    "GET /species/{id}/guide"            = { group = "species", auth = "jwt" }
    "GET /species/{id}/care-suggestions" = { group = "species", auth = "jwt" }

    # --- climate (household-scoped paths, served by the climate Lambda) ---
    "GET /households/{id}/climate"  = { group = "climate", auth = "jwt" }
    "PUT /households/{id}/location" = { group = "climate", auth = "jwt" }

    # --- api keys (management; JWT) ---
    "GET /api-keys"         = { group = "apiKeys", auth = "jwt" }
    "POST /api-keys"        = { group = "apiKeys", auth = "jwt" }
    "DELETE /api-keys/{id}" = { group = "apiKeys", auth = "jwt" }

    # --- health (unauthenticated liveness probe for synthetic monitoring) ---
    "GET /health" = { group = "api", auth = "none" }

    # --- public API v1 (authenticated by API key inside the handler) ---
    "GET /api/v1/me"          = { group = "api", auth = "none" }
    "GET /api/v1/plants"      = { group = "api", auth = "none" }
    "GET /api/v1/plants/{id}" = { group = "api", auth = "none" }
    "GET /api/v1/tasks"       = { group = "api", auth = "none" }
    "GET /api/v1/activity"    = { group = "api", auth = "none" }

    # --- chat (Claude on Bedrock + tool use) ---
    "POST /chat/messages"                   = { group = "chat", auth = "jwt" }
    "GET /chat/conversations/{id}/messages" = { group = "chat", auth = "jwt" }
    "GET /chat/budget"                      = { group = "chat", auth = "jwt" }
  }
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.handlers[each.value.group].id}"

  authorization_type = each.value.auth == "jwt" ? "JWT" : "NONE"
  authorizer_id      = each.value.auth == "jwt" ? aws_apigatewayv2_authorizer.cognito.id : null
}

# Hourly reminder scan: EventBridge invokes the `reminders` Lambda, which scans
# every household for due tasks and fans out notifications. See
# backend/src/handlers/reminders/handler.ts.
resource "aws_cloudwatch_event_rule" "reminders" {
  name                = "${var.project_name}-reminders-${var.environment}"
  description         = "Hourly plant-care reminder scan"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "reminders" {
  rule = aws_cloudwatch_event_rule.reminders.name
  arn  = aws_lambda_function.handlers["reminders"].arn
}

resource "aws_lambda_permission" "reminders_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handlers["reminders"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reminders.arn
}
