#!/bin/bash
set -euo pipefail

ENVIRONMENT=${1:-staging}

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
    echo "Usage: ./deploy.sh [staging|production]"
    exit 1
fi

# The whole stack lives in us-east-1. Terraform pins the region via its
# provider, but the raw `aws` CLI calls below (lambda, s3, cloudfront) inherit
# the caller's default region — which on a dev machine may be anything (a
# us-west-2 default once silently sent every `update-function-code` to the
# wrong region, 404ing while the loop's `|| echo` hid the failure). Pin it.
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}"
# Bucket that holds per-version Lambda zips the CD auto-rollback restores from;
# manual deploys archive here too so a later rollback can find this version.
ARTIFACT_BUCKET="family-greenhouse-tfstate-014248889144"

echo "Deploying to $ENVIRONMENT..."

# Backend bundle must exist before the post-apply Lambda push.
# (Terraform's lifecycle.ignore_changes on filename/source_code_hash means
# the initial `apply` ships placeholder code; real code lands via
# update-function-code below.)
echo "Building backend..."
npm --workspace backend run build

# Terraform
echo "Applying Terraform..."
cd infrastructure
# Per-environment state isolation. Production keeps the original
# `terraform.tfstate` key (backend.tf default) so its existing state is
# untouched; staging gets its OWN key. Without this the two environments
# share one state file — and a `terraform apply -var-file=staging` against
# the prod-populated state would rename every `-production` resource to
# `-staging` and destroy the live stack. `-reconfigure` re-points the backend
# cleanly when alternating environments locally.
if [[ "$ENVIRONMENT" == "staging" ]]; then
    terraform init -reconfigure -backend-config="key=staging/terraform.tfstate"
else
    terraform init -reconfigure
fi
terraform apply -var-file="environments/${ENVIRONMENT}/terraform.tfvars" -auto-approve

# Read outputs needed for the frontend build + asset sync
FRONTEND_BUCKET=$(terraform output -raw frontend_bucket_name)
CLOUDFRONT_ID=$(terraform output -raw cloudfront_distribution_id)
API_URL=$(terraform output -raw api_url)
COGNITO_POOL_ID=$(terraform output -raw cognito_user_pool_id)
COGNITO_CLIENT_ID=$(terraform output -raw cognito_client_id)
AWS_REGION=$(terraform output -raw aws_region 2>/dev/null || echo "us-east-1")
cd ..

# Build the frontend with prod-scoped env vars (Vite inlines these at build time).
echo "Building frontend..."
VITE_API_URL="$API_URL" \
VITE_COGNITO_USER_POOL_ID="$COGNITO_POOL_ID" \
VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" \
VITE_COGNITO_REGION="$AWS_REGION" \
    npm --workspace frontend run build

# Deploy frontend
echo "Deploying frontend to S3..."
aws s3 sync frontend/dist "s3://${FRONTEND_BUCKET}" \
    --delete \
    --cache-control "max-age=31536000,public" \
    --exclude "index.html" \
    --exclude "*.json"

aws s3 cp frontend/dist/index.html "s3://${FRONTEND_BUCKET}/index.html" \
    --cache-control "max-age=0,no-cache,no-store,must-revalidate"

# Invalidate CloudFront
echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
    --distribution-id "$CLOUDFRONT_ID" \
    --paths "/*" >/dev/null

# Deploy Lambda functions.
# esbuild emits ESM bundles named after the handler group (e.g. `auth.js`),
# but every Lambda is configured with `handler = "handler.handler"`. We
# repackage each bundle as `handler.mjs` so Node resolves the right module
# regardless of the zip's package.json.
echo "Deploying Lambda functions..."
# chat-stream is the Function-URL streaming handler (bundle chat-stream.js);
# digests is the EventBridge weekly/yearly email job. Keep this list in sync
# with infrastructure/modules/api locals + the CD workflow's deploy loop.
HANDLERS=(auth plants tasks households me billing notifications species climate apiKeys api reminders chat digests chat-stream)
for handler in "${HANDLERS[@]}"; do
    FUNCTION_NAME="family-greenhouse-${handler}-${ENVIRONMENT}"
    SRC="backend/dist/${handler}.js"

    if [[ ! -f "$SRC" ]]; then
        echo "  Skipping ${handler}: ${SRC} not found"
        continue
    fi

    WORK=$(mktemp -d)
    cp "$SRC" "${WORK}/handler.mjs"
    [[ -f "${SRC}.map" ]] && cp "${SRC}.map" "${WORK}/handler.mjs.map"
    ZIP="$(pwd)/.deploy-${handler}.zip"
    (cd "$WORK" && zip -q -r "$ZIP" .)

    PUBLISHED_VER=$(aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --region us-east-1 \
        --zip-file "fileb://${ZIP}" \
        --publish --query 'Version' --output text 2>/dev/null) \
        && echo "  ✓ ${FUNCTION_NAME} (v${PUBLISHED_VER})" \
        || { echo "  ✗ ${FUNCTION_NAME} (not found or update failed)"; rm -rf "$WORK" "$ZIP"; continue; }

    # Archive this version's zip so CD auto-rollback can restore it later.
    aws s3 cp "$ZIP" \
        "s3://${ARTIFACT_BUCKET}/lambda-versions/${handler}-v${PUBLISHED_VER}.zip" \
        --region us-east-1 --only-show-errors || true

    rm -rf "$WORK" "$ZIP"
done

echo ""
echo "Deployment to $ENVIRONMENT complete!"
