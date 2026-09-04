terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.iam]
    }
  }
}

# Account id for scoping IAM resource ARNs (e.g. the SES send fallback below).
data "aws_caller_identity" "current" {}

locals {
  # Web origin first — backend link-building falls back to the FIRST entry of
  # the comma-joined ALLOWED_ORIGIN env (middleware/handler.ts
  # firstAllowedOrigin), so order matters here.
  allowed_origins = concat([var.allowed_origin], var.native_app_origins)
  # AWS managed CORS accepts only HTTP(S) origins. Keep the full exact list in
  # ALLOWED_ORIGIN for Lambda-owned responses, but filter custom WebView
  # schemes (notably capacitor:// on iOS) out of API Gateway / Function URL.
  # Native shells use CapacitorHttp and do not depend on browser CORS. Do NOT
  # remove this managed block: it also stamps Gateway-owned JWT 401 responses,
  # which the website must read in order to run its refresh-token flow.
  managed_cors_origins = [
    for origin in local.allowed_origins : origin
    if can(regex("^https?://", origin))
  ]
  # The Sprout SDK accepts either a Secrets Manager name or a full ARN.
  # Secret-name ARNs carry an AWS-generated suffix, so a name needs a trailing
  # wildcard. When Sprout is disabled, point at a deliberately nonexistent
  # secret instead of granting the role access to every secret in the account.
  sprout_secret_arn = var.sprout_integration_secret_id == "" ? "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:family-greenhouse/sprout-disabled" : (
    startswith(var.sprout_integration_secret_id, "arn:") ? var.sprout_integration_secret_id : "arn:aws:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:${var.sprout_integration_secret_id}*"
  )
}

# API Gateway
resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = local.managed_cors_origins
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
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
      requestId               = "$context.requestId"
      ip                      = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      httpMethod              = "$context.httpMethod"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      responseLength          = "$context.responseLength"
      responseLatency         = "$context.responseLatency"
      integrationLatency      = "$context.integrationLatency"
      integrationStatus       = "$context.integrationStatus"
      integrationErrorMessage = "$context.integrationErrorMessage"
      errorMessage            = "$context.error.message"
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
  provider = aws.iam

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
          "dynamodb:BatchWriteItem",
          "dynamodb:ConditionCheckItem",
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
          "s3:GetObject",
          "s3:DeleteObject",
          # Production image buckets are versioned. Erasure must remove the
          # underlying versions, not merely create another delete marker.
          "s3:DeleteObjectVersion"
        ]
        Resource = "${var.images_bucket_arn}/*"
      },
      {
        # Plant/account deletion enumerates every image below the plant prefix.
        # ListBucket is a bucket-level action and cannot share the object ARN
        # above; keep it constrained to the only prefix the API manages.
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:ListBucketVersions"
        ]
        Resource = var.images_bucket_arn
        Condition = {
          StringLike = {
            "s3:prefix" = ["plants/*"]
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes",
          # DELETE /me removes the caller from Cognito after application data
          # is erased. Without this grant the endpoint completes its DDB work
          # and then returns 500, leaving the login identity behind.
          "cognito-idp:AdminDeleteUser"
        ]
        Resource = "arn:aws:cognito-idp:*:*:userpool/${var.cognito_user_pool_id}"
      },
      {
        # Outbound app email via SES — reminders, digests, the welcome mail and
        # the billing-lifecycle mail (ADR 0023). One role serves every handler
        # Lambda, so no per-handler grant is needed; only the SES_FROM_EMAIL
        # environment variable is per-handler. Scoped to the verified domain identity when
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
        # Sending WITH a configuration set is authorized against the identity
        # above on the v1 SendEmail API, but the configuration-set ARN is a
        # separate resource type on the v2 API and in SES's own condition keys.
        # Granting it explicitly means a later move to SendEmailV2 (which
        # multipart HTML and List-Unsubscribe headers will need) doesn't fail
        # with an opaque AccessDenied on the first send.
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "arn:aws:ses:*:${data.aws_caller_identity.current.account_id}:configuration-set/*"
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
        # Read-only access to encrypted Parameter Store values under the
        # `family-greenhouse/*` prefix. Used by services that fetch
        # credentials at Lambda cold start.
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
        ]
        Resource = [
          "arn:aws:ssm:*:*:parameter/family-greenhouse/*",
        ]
      },
      {
        # HMAC credential for the optional first-party Sprout chat path.
        # This action is required by services/sprout.ts when the configured
        # SecretId is used instead of the local-development literal fallback.
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.sprout_secret_arn
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
    # Also not an HTTP group — SNS-invoked. The SES configuration set publishes
    # bounce/complaint/delivery events to the topic this function subscribes to
    # (see the subscription below), and the handler maintains the outbound
    # suppression list. Same harmless unused API integration as reminders.
    "emailEvents" = "emailEvents"
    # Bedrock-backed plant care chatbot. Memory + timeout are higher than the
    # default because a turn can run up to 5 tool calls, each one a Bedrock
    # InvokeModel that takes 2-6 seconds.
    "chat" = "chat"
  }
}

# Non-secret environment shared by every backend Lambda. Provider credentials
# are added only to the handlers that use them below; in particular, the
# public Function URL for chat streaming must never inherit Stripe, SES, SMS,
# VAPID, Plant.id, or other unrelated credentials.
locals {
  lambda_environment = {
    NODE_ENV             = var.environment
    TABLE_NAME           = var.dynamodb_table_name
    COGNITO_USER_POOL_ID = var.cognito_user_pool_id
    COGNITO_CLIENT_ID    = var.cognito_client_id
    IMAGES_BUCKET        = var.images_bucket_name
    # Comma-separated: web origin first, then the Capacitor shell origins.
    # middleware/handler.ts resolveCorsOrigins splits this; link-building
    # code uses the first entry only.
    ALLOWED_ORIGIN = join(",", local.allowed_origins)
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
    # Source maps in stack traces: esbuild already emits them; this flag
    # tells Node 20 to actually use them when printing CloudWatch errors.
    NODE_OPTIONS = "--enable-source-maps"
    # Sentry DSNs are intentionally non-secret client ingestion identifiers.
    SENTRY_DSN                = var.sentry_dsn
    SENTRY_TRACES_SAMPLE_RATE = var.sentry_traces_sample_rate
    GIT_SHA                   = var.git_sha
  }

  stripe_environment = {
    STRIPE_SECRET_KEY                 = var.stripe_secret_key
    STRIPE_WEBHOOK_SECRET             = var.stripe_webhook_secret
    STRIPE_PRICE_ID_GARDEN            = var.stripe_price_id_garden
    STRIPE_PRICE_ID_GARDEN_ANNUAL     = var.stripe_price_id_garden_annual
    STRIPE_PRICE_ID_GARDEN_LIFETIME   = var.stripe_price_id_garden_lifetime
    STRIPE_PRICE_ID_GREENHOUSE        = var.stripe_price_id_greenhouse
    STRIPE_PRICE_ID_GREENHOUSE_ANNUAL = var.stripe_price_id_greenhouse_annual
    STRIPE_AUTOMATIC_TAX_ENABLED      = var.stripe_automatic_tax_enabled
    PAYMENTS_ENABLED                  = var.payments_enabled
    POSTHOG_KEY                       = var.posthog_key
    POSTHOG_HOST                      = var.posthog_host
  }

  email_environment = {
    SES_FROM_EMAIL = var.ses_from_email
    # Reply-To on the app's own sends. `hello@` is the sender; `support@` is
    # the address a human reads, so a reply to a reminder reaches somebody.
    SES_REPLY_TO = var.ses_reply_to_email
    # Attaching the configuration set is what turns bounce/complaint feedback
    # on for a message. An unset value sends without one — mail still goes out,
    # but nothing ever learns that it bounced.
    SES_CONFIGURATION_SET = var.ses_configuration_set
  }

  notification_environment = merge(local.email_environment, {
    WEB_PUSH_VAPID_PUBLIC_KEY  = var.web_push_vapid_public_key
    WEB_PUSH_VAPID_PRIVATE_KEY = var.web_push_vapid_private_key
    WEB_PUSH_VAPID_SUBJECT     = var.web_push_vapid_subject
    SMS_NOTIFICATIONS_ENABLED  = var.sms_notifications_enabled
  })

  plant_integration_environment = {
    PLANT_ID_API_KEY          = var.plant_id_api_key
    IDENTIFY_METERING_ENABLED = var.identify_metering_enabled
    # Leaf health uses the same Bedrock model selector as chat.
    BEDROCK_CHAT_MODEL_ID = var.bedrock_chat_model_id
    # Per-household monthly leaf-health caps (services/leafHealthBudget.ts).
    # Empty = code default (flat 200); an empty per-tier value inherits the flat one.
    LEAF_HEALTH_MONTHLY_CAP            = var.leaf_health_monthly_cap
    LEAF_HEALTH_MONTHLY_CAP_SEEDLING   = var.leaf_health_monthly_cap_seedling
    LEAF_HEALTH_MONTHLY_CAP_GARDEN     = var.leaf_health_monthly_cap_garden
    LEAF_HEALTH_MONTHLY_CAP_GREENHOUSE = var.leaf_health_monthly_cap_greenhouse
  }

  weather_environment = {
    OPENWEATHER_API_KEY      = var.openweather_api_key
    OPENWEATHER_DAILY_BUDGET = var.openweather_daily_budget
  }

  perenual_environment = {
    PERENUAL_API_KEY_PARAMETER_NAME = var.perenual_api_key_parameter_name
    PERENUAL_DAILY_BUDGET           = var.perenual_daily_budget
  }

  chat_environment = merge(local.weather_environment, {
    BEDROCK_CHAT_MODEL_ID        = var.bedrock_chat_model_id
    BEDROCK_INPUT_USD_PER_MTOK   = var.bedrock_input_usd_per_mtok
    BEDROCK_OUTPUT_USD_PER_MTOK  = var.bedrock_output_usd_per_mtok
    CHAT_ENABLED                 = var.chat_enabled
    BEDROCK_EMBED_MODEL_ID       = var.bedrock_embed_model_id
    SPROUT_INTEGRATION_ENABLED   = var.sprout_integration_enabled
    SPROUT_API_URL               = var.sprout_api_url
    SPROUT_INTEGRATION_SECRET_ID = var.sprout_integration_secret_id
    CHAT_BUDGET_INPUT_TOKENS     = var.chat_budget_input_tokens
    CHAT_BUDGET_OUTPUT_TOKENS    = var.chat_budget_output_tokens
    # Per-tier chat budgets (services/chat/budget.ts). Empty inherits the flat pair above.
    CHAT_BUDGET_INPUT_TOKENS_SEEDLING    = var.chat_budget_input_tokens_seedling
    CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING   = var.chat_budget_output_tokens_seedling
    CHAT_BUDGET_INPUT_TOKENS_GARDEN      = var.chat_budget_input_tokens_garden
    CHAT_BUDGET_OUTPUT_TOKENS_GARDEN     = var.chat_budget_output_tokens_garden
    CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE  = var.chat_budget_input_tokens_greenhouse
    CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE = var.chat_budget_output_tokens_greenhouse
  })

  handler_integration_environment = {
    auth   = {}
    plants = merge(local.plant_integration_environment, local.perenual_environment)
    tasks  = {}
    # Email for the welcome mail + member upgrade requests; VAPID so the
    # upgrade request can also reach admins as a browser/native push.
    households = local.notification_environment
    # SES_FROM_EMAIL: DELETE /me sends the account-deletion confirmation
    # (ADR 0023). Without it `emailNotifier.sendEmail` dry-runs and the
    # confirmation is a log line nobody reads.
    me            = local.email_environment
    notifications = merge(local.notification_environment, local.perenual_environment)
    # SES_FROM_EMAIL alongside the Stripe config: the webhook sends the
    # money-lifecycle emails (receipt, renewal notice, payment failure, card
    # expiring, cancellation — ADR 0023). Merged rather than replaced so the
    # Stripe keys are untouched.
    billing = merge(local.stripe_environment, local.email_environment)
    species = local.perenual_environment
    climate = local.weather_environment
    apiKeys = {}
    api     = {}
    # Reminders also get weather: services/reminders.ts adds a rain/frost line
    # to the daily reminder ("Rain is forecast — outdoor plants likely don't
    # need watering today"), which is the exact case that advice exists for.
    # Until this is applied the Lambda has no OPENWEATHER_API_KEY, climate
    # reads raise ClimateUnavailableError('not_configured'), and the reminder
    # simply omits the line — it never asserts "no rain expected".
    # Cost: the forecast is read at most once per household per reminder run,
    # cached for an hour per ~10km cell and shared with the climate endpoint.
    reminders   = merge(local.notification_environment, local.perenual_environment, local.weather_environment)
    digests     = local.email_environment
    emailEvents = {}
    chat        = local.chat_environment
  }

  handler_environments = {
    for handler in keys(local.lambda_handlers) :
    handler => merge(
      local.lambda_environment,
      local.handler_integration_environment[handler]
    )
  }

  # The streaming function runs the same chat service plus in-handler Cognito
  # verification, but receives only chat/weather integration values.
  chat_stream_environment = merge(
    local.lambda_environment,
    local.chat_environment,
    { APPLICATION_CORS_ENABLED = tostring(var.application_cors_enabled) }
  )
}

resource "aws_lambda_function" "handlers" {
  for_each = local.lambda_handlers

  function_name = "${var.project_name}-${each.key}-${var.environment}"
  role          = aws_iam_role.lambda.arn
  handler       = "handler.handler"
  # Bumped from nodejs20.x (CQ-03 — Node 22 is current LTS; CI/.nvmrc/engines
  # moved together, see CHANGELOG.md). This is a real infrastructure change —
  # applying it redeploys every Lambda function on the new runtime. Reviewed
  # here as a file edit only; `terraform apply` against real AWS is a
  # deliberate action for the maintainer to run, not something done as part
  # of this conformance-remediation pass.
  runtime = "nodejs22.x"
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
    variables = local.handler_environments[each.key]
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
  provider = aws.iam

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
        # The streaming and synchronous chat entry points share turnEvents(),
        # including its optional Sprout branch, so both roles need the same
        # narrowly scoped HMAC-secret read.
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.sprout_secret_arn
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
  runtime       = "nodejs22.x"
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
    variables = local.chat_stream_environment
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
    allow_origins = local.managed_cors_origins
    allow_methods = ["POST"]
    allow_headers = ["content-type", "authorization", "x-household-id"]
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

  # Function URL creation also updates the Lambda resource policy. Serialize
  # this explicit statement so first-time stacks do not race two AddPermission
  # calls and fail with ResourceConflictException.
  depends_on = [aws_lambda_function_url.chat_stream]
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
    # Catch-all unauthenticated preflight. While API Gateway managed CORS is
    # present it answers before routing; this route prepares the application
    # to take ownership without an API-wide preflight outage.
    "OPTIONS /{proxy+}" = { group = "api", auth = "none" }

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

    # --- household plant spaces + plants ---
    "GET /spaces"                     = { group = "plants", auth = "jwt" }
    "POST /spaces"                    = { group = "plants", auth = "jwt" }
    "PUT /spaces/{id}"                = { group = "plants", auth = "jwt" }
    "DELETE /spaces/{id}"             = { group = "plants", auth = "jwt" }
    "GET /plants"                     = { group = "plants", auth = "jwt" }
    "POST /plants"                    = { group = "plants", auth = "jwt" }
    "POST /plants/move"               = { group = "plants", auth = "jwt" }
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
    "GET /tasks"                = { group = "tasks", auth = "jwt" }
    "GET /tasks/upcoming"       = { group = "tasks", auth = "jwt" }
    "POST /tasks"               = { group = "tasks", auth = "jwt" }
    "GET /tasks/{id}"           = { group = "tasks", auth = "jwt" }
    "PUT /tasks/{id}"           = { group = "tasks", auth = "jwt" }
    "DELETE /tasks/{id}"        = { group = "tasks", auth = "jwt" }
    "POST /tasks/{id}/complete" = { group = "tasks", auth = "jwt" }
    # Household toolkit (Garden+): schedule-drift read + one-tap match.
    "GET /plants/{plantId}/schedule-drift"  = { group = "tasks", auth = "jwt" }
    "POST /tasks/{id}/match-schedule"       = { group = "tasks", auth = "jwt" }
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
    "GET /sitter/{token}/brief"                    = { group = "tasks", auth = "none" }
    "POST /sitter/{token}/tasks/{taskId}/complete" = { group = "tasks", auth = "none" }
    # Away Kit photo-back (auth=none, same token). The upload is the one
    # unauthenticated WRITE into the photo store: 300 KB/file, 60/link
    # (atomic DynamoDB counter), image magic bytes verified, IP + per-token
    # rate limits, refused after expiresAt — handlers/tasks/sitterPhotos.ts.
    "GET /sitter/{token}/photos"  = { group = "tasks", auth = "none" }
    "POST /sitter/{token}/photos" = { group = "tasks", auth = "none" }

    # Kiosk (wall display) PUBLIC endpoints (auth=none). Same token model as
    # the sitter routes above, but LONG-LIVED: the token sits on a screen in a
    # shared room and must be assumed leaked, so the surface is exactly two
    # operations (read today's tasks, complete one), PII-free, IP-rate-limited,
    # and revocable in one click. See backend/src/services/kioskService.ts.
    "GET /kiosk/{token}"                          = { group = "tasks", auth = "none" }
    "POST /kiosk/{token}/tasks/{taskId}/complete" = { group = "tasks", auth = "none" }

    # --- households (invite preview is public) ---
    "POST /households"                                    = { group = "households", auth = "jwt" }
    "GET /households/{id}"                                = { group = "households", auth = "jwt" }
    "POST /households/{id}/invites"                       = { group = "households", auth = "jwt" }
    "POST /households/{id}/invites/email"                 = { group = "households", auth = "jwt" }
    "GET /households/invites/{inviteCode}"                = { group = "households", auth = "none" }
    "POST /households/join/{inviteCode}"                  = { group = "households", auth = "jwt" }
    "GET /households/{id}/activity"                       = { group = "households", auth = "jwt" }
    "GET /households/{id}/analytics/daily"                = { group = "households", auth = "jwt" }
    "GET /households/{id}/year-in-review"                 = { group = "households", auth = "jwt" }
    "PUT /households/{householdId}/members/{userId}/role" = { group = "households", auth = "jwt" }
    "DELETE /households/{householdId}/members/{userId}"   = { group = "households", auth = "jwt" }
    # Sitter-link management (authed, any household member — ADR 0015; the
    # handler scopes revoke to the creator or an admin). Create returns the
    # token once; list/revoke never expose it. The public sitter routes are above.
    "POST /households/{id}/sitter-links"            = { group = "households", auth = "jwt" }
    "GET /households/{id}/sitter-links"             = { group = "households", auth = "jwt" }
    "DELETE /households/{id}/sitter-links/{linkId}" = { group = "households", auth = "jwt" }
    # Kiosk-link management (authed, admin-gated, Greenhouse-gated). Issue
    # returns the token once and revokes any previous one; get/revoke never
    # expose it. The public kiosk routes are above.
    "POST /households/{id}/kiosk-link"   = { group = "households", auth = "jwt" }
    "GET /households/{id}/kiosk-link"    = { group = "households", auth = "jwt" }
    "DELETE /households/{id}/kiosk-link" = { group = "households", auth = "jwt" }
    # A member asks the household's admins to upgrade for a locked feature
    # (email + push + activity row; once per member per feature per week).
    "POST /households/{id}/upgrade-requests" = { group = "households", auth = "jwt" }
    # Away Kit return recap (authed, any member): replays sitter-attributed
    # activity inside a link's window — handlers/households/awayRecap.ts.
    "GET /households/{id}/away-recap" = { group = "households", auth = "jwt" }

    # --- me ---
    "DELETE /me"                = { group = "me", auth = "jwt" }
    "GET /me/export"            = { group = "me", auth = "jwt" }
    "GET /me/households"        = { group = "me", auth = "jwt" }
    "GET /me/calendar.ics"      = { group = "me", auth = "jwt" }
    "GET /me/calendar-token"    = { group = "me", auth = "jwt" }
    "POST /me/calendar-token"   = { group = "me", auth = "jwt" }
    "DELETE /me/calendar-token" = { group = "me", auth = "jwt" }
    # Capability URL for calendar apps: the token in the path is the credential.
    "GET /calendar/{token}/family-greenhouse.ics" = { group = "me", auth = "none" }

    # --- notifications ---
    "GET /notifications/prefs" = { group = "notifications", auth = "jwt" }
    "PUT /notifications/prefs" = { group = "notifications", auth = "jwt" }
    # Self-service un-suppression: puts the CALLER'S OWN address back on the
    # send list after a bounce or complaint. The address comes from the JWT,
    # never the request body, so it can only ever affect the caller.
    "DELETE /notifications/email-suppression" = { group = "notifications", auth = "jwt" }
    "POST /notifications/subscribe"           = { group = "notifications", auth = "jwt" }
    "POST /notifications/unsubscribe"         = { group = "notifications", auth = "jwt" }
    "POST /notifications/run-reminders"       = { group = "notifications", auth = "jwt" }
    # Admin-only manual triggers for the EventBridge-scheduled digest/recap
    # jobs, plus the SMS phone-verification flow (code via SNS; SMS sends are
    # gated on a verified number).
    "POST /notifications/run-digests"                = { group = "notifications", auth = "jwt" }
    "POST /notifications/run-year-recap"             = { group = "notifications", auth = "jwt" }
    "POST /notifications/phone/start-verification"   = { group = "notifications", auth = "jwt" }
    "POST /notifications/phone/confirm-verification" = { group = "notifications", auth = "jwt" }
    # Native (Capacitor iOS/Android) push device tokens — capture-only until
    # the APNs/FCM sender ships (docs/mobile.md § Push notifications).
    "POST /notifications/devices"        = { group = "notifications", auth = "jwt" }
    "POST /notifications/devices/remove" = { group = "notifications", auth = "jwt" }

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

    # --- first-party telemetry ---
    # Browser failures must be reportable before login; product events use
    # JWT identity so actor/household cannot be forged in the request body.
    "POST /telemetry/frontend" = { group = "api", auth = "none" }
    "POST /telemetry/product"  = { group = "api", auth = "jwt" }

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

# Weekly plants-at-risk digest: four Monday passes, six hours apart. Each pass
# respects the recipient's local quiet hours and per-user weekly markers make
# the first eligible delivery win without duplicates.
resource "aws_cloudwatch_event_rule" "digests_weekly" {
  name                = "${var.project_name}-digests-weekly-${var.environment}"
  description         = "Weekly plants-at-risk digest emails"
  schedule_expression = "cron(0 0,6,12,18 ? * MON *)"
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

# Year-in-review recap: four passes on Jan 2, six hours apart — recaps the
# PREVIOUS calendar year (the service defaults the year). Recipient-local DND
# plus annual markers defer quiet-hour recipients without duplicates.
resource "aws_cloudwatch_event_rule" "year_recap" {
  name                = "${var.project_name}-year-recap-${var.environment}"
  description         = "End-of-year recap emails (previous calendar year)"
  schedule_expression = "cron(0 0,6,12,18 2 1 ? *)"
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

# --- SES delivery feedback ---------------------------------------------------
# The configuration set (modules/email) publishes bounce/complaint/delivery
# events to an SNS topic; this subscribes the emailEvents Lambda to it. The
# topic is created in the email module (next to the identity it reports on) and
# the subscription here (next to the function it delivers to) so the dependency
# stays one-way — email -> api — instead of becoming a cycle.
#
# `count` rather than an unconditional resource: an environment with no domain
# has no email module, hence no topic. The function is still deployed there;
# it just never receives anything.
resource "aws_sns_topic_subscription" "email_events" {
  count = var.ses_event_topic_arn == "" ? 0 : 1

  topic_arn = var.ses_event_topic_arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.handlers["emailEvents"].arn
}

resource "aws_lambda_permission" "email_events_sns" {
  count = var.ses_event_topic_arn == "" ? 0 : 1

  statement_id  = "AllowSNSInvokeEmailEvents"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handlers["emailEvents"].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = var.ses_event_topic_arn
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
