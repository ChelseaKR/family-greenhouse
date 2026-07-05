# Account id for scoping IAM resource ARNs (e.g. the SES send fallback below).
data "aws_caller_identity" "current" {}

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
        # Reminder email via SES. Scoped to the verified domain identity when
        # one is provisioned (prod). Identity-less environments (dev/staging
        # without a domain) can't send at all — no identity is verified — but
        # rather than fall back to "*", scope to THIS account's SES identities
        # so the grant can never apply outside the account even if one is later
        # verified.
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = var.ses_identity_arn == "" ? "arn:aws:ses:*:${data.aws_caller_identity.current.account_id}:identity/*" : var.ses_identity_arn
      },
      {
        # Reminder SMS via SNS. Resource "*" is REQUIRED by AWS here:
        # publishing directly to a phone number has no ARN to scope to (only
        # topic publishes do), so this cannot be tightened further. Web push
        # needs no IAM (VAPID over HTTPS).
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = "*"
      },
      {
        # Send failed async invocations to the dead-letter queue.
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.lambda_dlq.arn
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
    # Also EventBridge-only: weekly plants-at-risk digest + yearly recap
    # emails. One function, two rules — the constant rule input
    # ({"job": "weekly"} / {"job": "yearRecap"}) selects the routine inside
    # backend/src/handlers/digests/handler.ts.
    "digests" = "digests"
    # Bedrock-backed plant care chatbot. Memory + timeout are higher than the
    # default because a turn can run up to 5 tool calls, each one a Bedrock
    # InvokeModel that takes 2-6 seconds.
    "chat" = "chat"
  }
}

# Environment shared by EVERY backend Lambda — the for_each fleet below AND
# the standalone chat_stream function (which must see the exact same config:
# it runs the same chat service code, plus the Cognito vars its in-handler
# JWT verification depends on). Single source of truth: add new variables
# HERE, never inline in one function's environment block.
locals {
  lambda_environment = {
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
    # ASSETS_BASE_URL: public base under which CloudFront serves the images
    # bucket. The plants handler mints photo URLs as
    # `${ASSETS_BASE_URL}/plants/{householdId}/{plantId}/...`, which the
    # /plants/* ordered cache behavior (modules/frontend/main.tf) routes to
    # the S3-images origin. Same value as the site origin today; separate
    # var-shaped contract so a future dedicated assets domain is a wiring
    # change only.
    ASSETS_BASE_URL = var.allowed_origin
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
    STRIPE_SECRET_KEY                 = var.stripe_secret_key
    STRIPE_WEBHOOK_SECRET             = var.stripe_webhook_secret
    STRIPE_PRICE_ID_GARDEN            = var.stripe_price_id_garden
    STRIPE_PRICE_ID_GARDEN_ANNUAL     = var.stripe_price_id_garden_annual
    STRIPE_PRICE_ID_GARDEN_LIFETIME   = var.stripe_price_id_garden_lifetime
    STRIPE_PRICE_ID_GREENHOUSE        = var.stripe_price_id_greenhouse
    STRIPE_PRICE_ID_GREENHOUSE_ANNUAL = var.stripe_price_id_greenhouse_annual
    SES_FROM_EMAIL                    = var.ses_from_email
    WEB_PUSH_VAPID_PUBLIC_KEY         = var.web_push_vapid_public_key
    WEB_PUSH_VAPID_PRIVATE_KEY        = var.web_push_vapid_private_key
    WEB_PUSH_VAPID_SUBJECT            = var.web_push_vapid_subject
    SMS_NOTIFICATIONS_ENABLED         = var.sms_notifications_enabled
    PLANT_ID_API_KEY                  = var.plant_id_api_key
    # Plant.id identify monthly meter. "1" enforces the per-household monthly
    # cap (blocks once exceeded); unset/"" only tracks usage (beta default).
    # Set to "1" in production so the real per-call Plant.id credit can't be
    # cost-amplified by concurrency.
    IDENTIFY_METERING_ENABLED = var.identify_metering_enabled
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
    # PostHog server-side analytics. Powers confirmed conversion events from
    # the Stripe webhook (subscription_activated). Empty key = emitter no-ops,
    # so nothing leaks from environments without a configured project key.
    POSTHOG_KEY  = var.posthog_key
    POSTHOG_HOST = var.posthog_host
  }
}

resource "aws_lambda_function" "handlers" {
  for_each = local.lambda_handlers

  function_name = "${var.project_name}-${each.key}-${var.environment}"
  role          = aws_iam_role.lambda.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  # arm64 (Graviton2) is ~20% cheaper per GB-second than x86 at equal or better
  # latency. Safe here because esbuild emits pure JS with no native/prebuilt
  # binaries (no sharp/bcrypt in the dependency tree), so the bundle is
  # architecture-independent.
  architectures = ["arm64"]
  # `chat` runs Bedrock InvokeModel up to 5 times per turn (Sonnet 4.6 latency
  # ~2-6s per call), and the tool-use loop can occasionally push past 30s.
  # 90s leaves margin without unbounded; memory bump shortens cold starts.
  timeout     = each.key == "chat" ? 90 : 30
  memory_size = each.key == "chat" ? 512 : 256

  # Cap chat concurrency to bound Bedrock spend + blast radius: a runaway
  # chat loop can't drain the 1000-account concurrency pool and brown out the
  # rest of the API. Other handlers stay unreserved (-1 = use the shared pool).
  reserved_concurrent_executions = each.key == "chat" ? 15 : -1

  filename         = "${path.module}/placeholder.zip"
  source_code_hash = filebase64sha256("${path.module}/placeholder.zip")

  environment {
    variables = local.lambda_environment
  }

  tracing_config {
    mode = "Active"
  }

  # Failed async invocations (the EventBridge-driven `reminders` Lambda) land
  # in the DLQ after Lambda's internal retries instead of vanishing. No-op for
  # the sync API-Gateway handlers, which return errors to the caller.
  dead_letter_config {
    target_arn = aws_sqs_queue.lambda_dlq.arn
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

# --- Streaming chat (Lambda Function URL, SSE) -------------------------------
# API Gateway HTTP APIs cannot stream responses, so the streaming chat
# endpoint is a STANDALONE Lambda behind a Function URL with
# invoke_mode = RESPONSE_STREAM — not part of the for_each fleet above.
# Bundle: backend `dist/chat-stream.js` (src/handlers/chat/streamHandler.ts,
# an explicit esbuild entry). CD zips it as `handler.mjs` exactly like the
# other bundles, hence the same "handler.handler" handler string.
# Dedicated, least-privilege execution role for the PUBLIC streaming-chat
# Function URL (authorization_type = NONE). The sync fleet's shared role grants
# the union of every backend privilege — secretsmanager:GetSecretValue,
# cognito-idp:AdminUpdateUserAttributes, SES, SNS, S3 — none of which the chat
# path uses (it touches only DynamoDB + Bedrock; climate caches in DDB and
# calls OpenWeather over HTTPS). Putting the most internet-exposed component on
# that shared role meant a flaw in its hand-rolled JWT/SSE path (before the
# in-handler 401) could exfiltrate secrets or escalate household roles. This
# role carries ONLY what chat actually needs, so that blast radius is gone.
resource "aws_iam_role" "chat_stream" {
  name = "${var.project_name}-chat-stream-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole"
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
      }
    ]
  })
}

resource "aws_iam_role_policy" "chat_stream" {
  name = "${var.project_name}-chat-stream-policy-${var.environment}"
  role = aws_iam_role.chat_stream.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        # Conversation persistence + the read/write tools (plants, tasks,
        # household, climate cache). Same table+indexes scope as the fleet.
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
        # Bedrock for the model turn + RAG corpus embedding. Same dual
        # foundation-model + inference-profile ARN shape as the fleet policy.
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
        # dead_letter_config target for failed async invocations.
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.lambda_dlq.arn
      }
    ]
  })
}

# Active tracing needs the same X-Ray write grant as the fleet role.
resource "aws_iam_role_policy_attachment" "chat_stream_xray" {
  role       = aws_iam_role.chat_stream.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_lambda_function" "chat_stream" {
  function_name = "${var.project_name}-chat-stream-${var.environment}"
  role          = aws_iam_role.chat_stream.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  # arm64 (Graviton2): ~20% cheaper at equal latency; pure-JS esbuild bundle is
  # architecture-independent. Same rationale as the `handlers` fleet above.
  architectures = ["arm64"]
  # Same sizing rationale as the sync `chat` member of the fleet above: up to
  # 5 Bedrock calls per turn at ~2-6s each.
  timeout     = 90
  memory_size = 512

  # Same blast-radius/Bedrock-spend cap as the sync `chat` member of the fleet
  # above: bound concurrent streaming turns so a runaway loop can't exhaust the
  # account concurrency pool.
  reserved_concurrent_executions = 15

  filename         = "${path.module}/placeholder.zip"
  source_code_hash = filebase64sha256("${path.module}/placeholder.zip")

  environment {
    variables = local.lambda_environment
  }

  tracing_config {
    mode = "Active"
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.lambda_dlq.arn
  }

  tags = {
    Name = "${var.project_name}-chat-stream-${var.environment}"
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

resource "aws_cloudwatch_log_group" "chat_stream" {
  name              = "/aws/lambda/${var.project_name}-chat-stream-${var.environment}"
  retention_in_days = 30
}

# authorization_type = "NONE" is deliberate and REQUIRED here, not an
# oversight: the only alternative, AWS_IAM, demands SigV4-signed requests,
# which a browser holding only a Cognito ID token cannot produce. AuthN/AuthZ
# happen INSIDE the handler instead — it verifies the Authorization Bearer
# JWT against the Cognito user pool (aws-jwt-verify: signature, issuer,
# audience, expiry, token_use) and re-checks household membership in DynamoDB
# before streaming a single byte; missing/forged tokens get 401 before any
# model call. So "NONE" means "Lambda itself imposes no IAM auth", NOT
# "unauthenticated".
resource "aws_lambda_function_url" "chat_stream" {
  function_name      = aws_lambda_function.chat_stream.function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"

  cors {
    allow_origins = [var.allowed_origin]
    allow_methods = ["POST"]
    allow_headers = ["Content-Type", "Authorization", "X-Household-Id"]
    max_age       = 300
  }
}

# With authorization_type = NONE, Lambda does NOT implicitly allow public
# invocation through the URL — this resource-policy statement is what grants
# it (the console adds the equivalent statement automatically; Terraform has
# to be explicit). Without it every Function URL call 403s.
resource "aws_lambda_permission" "chat_stream_url" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.chat_stream.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Since the October 2025 Lambda policy change, NONE-auth Function URLs reject
# requests with a front-door 403 unless the resource policy ALSO grants
# lambda:InvokeFunction (verified empirically on first deploy: the function
# was never invoked). AWS's canonical NONE-auth policy scopes that second
# statement with the `lambda:InvokedViaFunctionUrl` condition so it permits
# URL calls ONLY — but the AWS provider only gained an
# `invoked_via_function_url` argument in major version 6 (we pin ~> 5.0, and
# its `function_url_auth_type` argument is rejected by the API for the
# InvokeFunction action: "FunctionUrlAuthType is only supported for
# lambda:InvokeFunctionUrl").
#
# Until the provider-6 upgrade lands (dependabot PR #56), this ONE statement
# is managed OUTSIDE Terraform via the CLI (same out-of-band convention as
# Secrets Manager values). To (re)create it:
#
#   aws lambda add-permission \
#     --region us-east-1 \
#     --function-name family-greenhouse-chat-stream-production \
#     --statement-id AllowPublicFunctionUrlInvokeFunction \
#     --action lambda:InvokeFunction \
#     --principal "*" \
#     --invoked-via-function-url
#
# Without it the chat-stream URL 403s at the AWS front door — harmless while
# streaming is feature-flagged off (PRODUCTION_CHAT_STREAM_URL unset), but it
# must exist before enabling streaming. When provider 6 lands, replace the
# CLI statement with:
#
#   resource "aws_lambda_permission" "chat_stream_url_invoke" {
#     statement_id              = "AllowPublicFunctionUrlInvokeFunction"
#     action                    = "lambda:InvokeFunction"
#     function_name             = aws_lambda_function.chat_stream.function_name
#     principal                 = "*"
#     invoked_via_function_url  = true
#   }

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
    # Leaf-health check: Bedrock vision on an uploaded photo (rate-limited
    # in-handler; demo-mode fallback when Bedrock access is missing).
    "POST /plants/{id}/health-check" = { group = "plants", auth = "jwt" }
    # Bulk CSV/JSON import (≤100 plants/request; partial success on plan cap).
    "POST /plants/import" = { group = "plants", auth = "jwt" }
    # Cutting share: the preview is public by design (like invite preview) —
    # it serves a frozen snapshot (plant card + household name) and no other
    # household data; accept runs through the normal plan-capped createPlant.
    "POST /plants/{id}/share"           = { group = "plants", auth = "jwt" }
    "GET /plants/shared/{code}"         = { group = "plants", auth = "none" }
    "POST /plants/shared/{code}/accept" = { group = "plants", auth = "jwt" }

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
    "POST /tasks/{id}/claim"                = { group = "tasks", auth = "jwt" }
    "POST /tasks/{id}/unclaim"              = { group = "tasks", auth = "jwt" }
    # Vacation-mode care handoff. Exact-segment route keys win over {id}
    # params in HTTP API route selection, so /tasks/vacation never collides
    # with /tasks/{id}.
    "GET /tasks/vacation"             = { group = "tasks", auth = "jwt" }
    "PUT /tasks/vacation"             = { group = "tasks", auth = "jwt" }
    "DELETE /tasks/vacation/{userId}" = { group = "tasks", auth = "jwt" }

    # Plant-sitter PUBLIC endpoints (auth=none). A no-account sitter opens a
    # time-boxed link; the 256-bit token in the path is the only credential.
    # The handlers validate the token (existence + active + window) on every
    # call, expose only a PII-free due-task projection, and are IP-rate-limited.
    # Served by the tasks group (it owns task listing + completion).
    "GET /sitter/{token}"                          = { group = "tasks", auth = "none" }
    "POST /sitter/{token}/tasks/{taskId}/complete" = { group = "tasks", auth = "none" }

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
    # Sitter-link management (authed, admin-gated). Create returns the token
    # once; list/revoke never expose it. The public sitter routes are above.
    "POST /households/{id}/sitter-links"            = { group = "households", auth = "jwt" }
    "GET /households/{id}/sitter-links"             = { group = "households", auth = "jwt" }
    "DELETE /households/{id}/sitter-links/{linkId}" = { group = "households", auth = "jwt" }

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
    # Admin-only manual triggers for the EventBridge-scheduled digest/recap
    # jobs, plus the SMS phone-verification flow (code via SNS; SMS sends are
    # gated on a verified number).
    "POST /notifications/run-digests"                = { group = "notifications", auth = "jwt" }
    "POST /notifications/run-year-recap"             = { group = "notifications", auth = "jwt" }
    "POST /notifications/phone/start-verification"   = { group = "notifications", auth = "jwt" }
    "POST /notifications/phone/confirm-verification" = { group = "notifications", auth = "jwt" }

    # --- billing (plans + webhook public; webhook is Stripe-signed) ---
    "GET /billing/plans"     = { group = "billing", auth = "none" }
    "GET /billing/me"        = { group = "billing", auth = "jwt" }
    "POST /billing/checkout" = { group = "billing", auth = "jwt" }
    "POST /billing/portal"   = { group = "billing", auth = "jwt" }
    "POST /billing/webhook"  = { group = "billing", auth = "none" }

    # --- species ---
    "GET /species/search" = { group = "species", auth = "jwt" }
    # Public, no-auth pet-toxicity lookup behind the free "is this plant safe
    # for pets?" page. Resolves a hand-curated static table (no Perenual call),
    # serves no household data, and is cached publicly at the edge. Exact
    # segment, so it wins over the {id} route below in HTTP API selection.
    "GET /species/toxicity" = { group = "species", auth = "none" }
    "GET /species/{id}"     = { group = "species", auth = "jwt" }
    # Thumbnail is fetched by <img> tags, which cannot attach an
    # Authorization header — behind the JWT authorizer every species image
    # 401s. Public by design: the handler only 302-redirects to an
    # allowlisted external image host and serves no household data.
    "GET /species/{id}/thumbnail"        = { group = "species", auth = "none" }
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
    # Write endpoints: require an API key carrying the write:tasks scope
    # (checked in-handler; legacy all-read keys never gain write implicitly).
    "POST /api/v1/tasks/{id}/complete" = { group = "api", auth = "none" }
    "POST /api/v1/tasks/{id}/snooze"   = { group = "api", auth = "none" }

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

  # Bounded retry, then dead-letter so a delivery failure isn't lost silently.
  retry_policy {
    maximum_retry_attempts       = 4
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config {
    arn = aws_sqs_queue.lambda_dlq.arn
  }
}

resource "aws_lambda_permission" "reminders_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handlers["reminders"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reminders.arn
}

# Weekly plants-at-risk digest: Monday 13:00 UTC. The constant input selects
# the routine inside the digests handler; per-user weekly dedupe markers make
# retries safe. See backend/src/services/digest.ts.
resource "aws_cloudwatch_event_rule" "digests_weekly" {
  name                = "${var.project_name}-digests-weekly-${var.environment}"
  description         = "Weekly plants-at-risk digest emails"
  schedule_expression = "cron(0 13 ? * MON *)"
}

resource "aws_cloudwatch_event_target" "digests_weekly" {
  rule  = aws_cloudwatch_event_rule.digests_weekly.name
  arn   = aws_lambda_function.handlers["digests"].arn
  input = jsonencode({ job = "weekly" })

  retry_policy {
    maximum_retry_attempts       = 4
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config {
    arn = aws_sqs_queue.lambda_dlq.arn
  }
}

# Year-in-review recap: Jan 2, 13:00 UTC — recaps the PREVIOUS calendar year
# (the service defaults the year). Per-household sent markers make retries and
# manual re-runs safe.
resource "aws_cloudwatch_event_rule" "year_recap" {
  name                = "${var.project_name}-year-recap-${var.environment}"
  description         = "End-of-year recap emails (previous calendar year)"
  schedule_expression = "cron(0 13 2 1 ? *)"
}

resource "aws_cloudwatch_event_target" "year_recap" {
  rule  = aws_cloudwatch_event_rule.year_recap.name
  arn   = aws_lambda_function.handlers["digests"].arn
  input = jsonencode({ job = "yearRecap" })

  retry_policy {
    maximum_retry_attempts       = 4
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config {
    arn = aws_sqs_queue.lambda_dlq.arn
  }
}

resource "aws_lambda_permission" "digests_eventbridge" {
  statement_id  = "AllowEventBridgeInvokeWeekly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handlers["digests"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.digests_weekly.arn
}

resource "aws_lambda_permission" "year_recap_eventbridge" {
  statement_id  = "AllowEventBridgeInvokeYearRecap"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handlers["digests"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.year_recap.arn
}

# Dead-letter queue for failed ASYNCHRONOUS Lambda invocations. The only async
# path today is the hourly reminders scan (EventBridge → reminders Lambda); a
# sync API-Gateway invoke returns its error to the caller and doesn't use this.
# Without a DLQ, an async failure after Lambda's 2 internal retries is lost
# silently — a whole hour of reminders could vanish with no trace. The queue +
# the monitoring alarm on its depth make that visible. 14-day retention gives
# ample time to inspect/redrive.
resource "aws_sqs_queue" "lambda_dlq" {
  name                      = "${var.project_name}-lambda-dlq-${var.environment}"
  message_retention_seconds = 1209600 # 14 days

  tags = {
    Name = "${var.project_name}-lambda-dlq-${var.environment}"
  }
}

# SQS queue policy: allow EventBridge to send dead-lettered events here.
resource "aws_sqs_queue_policy" "lambda_dlq" {
  queue_url = aws_sqs_queue.lambda_dlq.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.lambda_dlq.arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = [
            aws_cloudwatch_event_rule.reminders.arn,
            aws_cloudwatch_event_rule.digests_weekly.arn,
            aws_cloudwatch_event_rule.year_recap.arn,
          ]
        }
      }
    }]
  })
}
