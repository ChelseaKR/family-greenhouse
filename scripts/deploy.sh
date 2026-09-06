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
VAPID_PUBLIC_KEY=$(terraform output -raw web_push_vapid_public_key)
AWS_REGION=$(terraform output -raw aws_region 2>/dev/null || echo "us-east-1")
cd ..

# Build the frontend with prod-scoped env vars (Vite inlines these at build time).
echo "Building frontend..."
VITE_API_URL="$API_URL" \
VITE_COGNITO_USER_POOL_ID="$COGNITO_POOL_ID" \
VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" \
VITE_COGNITO_REGION="$AWS_REGION" \
VITE_VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
    npm --workspace frontend run build

# Deploy frontend
echo "Deploying frontend to S3..."
# Hashed, immutable assets. The exclude here used to be the literal
# "index.html", which matches ONLY the root key — so pricing/index.html,
# blog/<slug>/index.html and app-shell.html all went up with a 1-year
# immutable cache at URLs that never change. The CD workflows already do the
# two-phase split below; this script had drifted from them.
aws s3 sync frontend/dist "s3://${FRONTEND_BUCKET}" \
    --delete \
    --cache-control "max-age=31536000,public" \
    --exclude "*.html" \
    --exclude "sw.js" \
    --exclude "push-handler.js" \
    --exclude "*.json" \
    --exclude "robots.txt" \
    --exclude "sitemap.xml" \
    --exclude ".well-known/*"

# All HTML, rebuilt every deploy at stable URLs.
aws s3 sync frontend/dist "s3://${FRONTEND_BUCKET}" \
    --delete \
    --exclude "*" \
    --include "*.html" \
    --cache-control "max-age=0,no-cache,no-store,must-revalidate"

aws s3 cp frontend/dist/robots.txt "s3://${FRONTEND_BUCKET}/robots.txt" \
    --cache-control "max-age=3600,public"
aws s3 cp frontend/dist/sitemap.xml "s3://${FRONTEND_BUCKET}/sitemap.xml" \
    --cache-control "max-age=3600,public"
aws s3 cp frontend/dist/sw.js "s3://${FRONTEND_BUCKET}/sw.js" \
    --cache-control "max-age=0,no-cache,no-store,must-revalidate"
aws s3 cp frontend/dist/push-handler.js "s3://${FRONTEND_BUCKET}/push-handler.js" \
    --cache-control "max-age=0,no-cache,no-store,must-revalidate"

# The deep-link association files, when a build carries them. Neither would be
# uploaded correctly by the syncs above: `assetlinks.json` matches
# `--exclude "*.json"` in the first and `*.html` in the second, so NEITHER sync
# claims it and it would never reach the bucket; `apple-app-site-association`
# is extensionless, so it matched no exclude and rode the immutable sync up
# with a 1-year max-age and a guessed `binary/octet-stream` content type, where
# Apple requires `application/json`. `--exclude ".well-known/*"` above keeps the
# generic sync off both, so these two commands are the only thing that uploads
# them and their headers are the headers the files get.
#
# Guarded, because the files are not in the tree yet (#469 §2): the app-side
# half needs the release keystore's SHA-256 fingerprint and the Apple Team ID,
# which this repo cannot supply. Until those land both tests are false and this
# is a no-op. Kept in step with the two CD workflows — this script has drifted
# from them before, and the last time it did every prerendered page went up
# immutable.
if [[ -f frontend/dist/.well-known/assetlinks.json ]]; then
    aws s3 cp frontend/dist/.well-known/assetlinks.json \
        "s3://${FRONTEND_BUCKET}/.well-known/assetlinks.json" \
        --content-type "application/json" \
        --cache-control "max-age=300,public"
fi
if [[ -f frontend/dist/.well-known/apple-app-site-association ]]; then
    aws s3 cp frontend/dist/.well-known/apple-app-site-association \
        "s3://${FRONTEND_BUCKET}/.well-known/apple-app-site-association" \
        --content-type "application/json" \
        --cache-control "max-age=300,public"
fi

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
# digests is the EventBridge weekly/yearly email job; emailEvents is the
# SNS-invoked SES bounce/complaint consumer. Keep this list in sync
# with infrastructure/modules/api locals + the CD workflow's deploy loop.
HANDLERS=(auth plants tasks households me billing notifications species climate apiKeys api reminders chat digests emailEvents chat-stream)
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

    # `if` rather than `A && B || C` (SC2015): in the `&&`/`||` form the failure
    # branch also runs when the UPDATE succeeded and the `echo` failed, which
    # would print "not found or update failed" for a Lambda that had just been
    # published and `continue` past the artifact archive below — leaving CD's
    # auto-rollback with no zip for a version that exists.
    if PUBLISHED_VER=$(aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --region us-east-1 \
        --zip-file "fileb://${ZIP}" \
        --publish --query 'Version' --output text 2>/dev/null); then
        echo "  ✓ ${FUNCTION_NAME} (v${PUBLISHED_VER})"
    else
        echo "  ✗ ${FUNCTION_NAME} (not found or update failed)"
        rm -rf "$WORK" "$ZIP"
        continue
    fi

    # Archive this version's zip so CD auto-rollback can restore it later.
    aws s3 cp "$ZIP" \
        "s3://${ARTIFACT_BUCKET}/lambda-versions/${handler}-v${PUBLISHED_VER}.zip" \
        --region us-east-1 --only-show-errors || true

    rm -rf "$WORK" "$ZIP"
done

echo ""
echo "Deployment to $ENVIRONMENT complete!"
