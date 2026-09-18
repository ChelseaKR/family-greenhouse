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
#
# NO --delete here, for the reason cd-production.yml gives at the same place:
# a tab open across a release holds the PREVIOUS index chunk, which names the
# previous `<Route>-<hash>.js`. Deleting that file in the same breath as
# uploading the new one turns the next lazy navigation into "The page's code
# couldn't be fetched" — observed on /confirm-email, the worst page for it,
# because a confirmation link is followed once and often in a tab that has been
# sitting open. The old objects are content-hashed and immutable, so keeping
# them costs storage and nothing else; the tagged release path prunes them
# after a grace period. This script had kept the `--delete` that incident
# removed from CD, which is the same drift the comment above records.
aws s3 sync frontend/dist "s3://${FRONTEND_BUCKET}" \
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

# A placeholder signing-certificate fingerprint must never reach the
# bucket either. `SHA256_PENDING` starts every sentinel in
# SIGNING_CERTIFICATES (frontend/scripts/asset-links.mjs) until the two
# SHA-256 values are pasted from Play Console -> Test and release -> App
# integrity -> App signing. The generator never writes the file while
# they are pending, so reaching this line means a hand-made file; published
# as-is it parses and is fetched by Google's verifier with a 200, and every
# App Link silently keeps opening the browser.
if [[ -f frontend/dist/.well-known/assetlinks.json ]] && \
    grep -q "SHA256_PENDING" frontend/dist/.well-known/assetlinks.json; then
    echo "frontend/dist/.well-known/assetlinks.json still carries a placeholder fingerprint (SHA256_PENDING)." >&2
    echo "Refusing to publish it: see docs/mobile.md, Android App Links." >&2
    exit 1
fi
if [[ -f frontend/dist/.well-known/assetlinks.json ]]; then
    aws s3 cp frontend/dist/.well-known/assetlinks.json \
        "s3://${FRONTEND_BUCKET}/.well-known/assetlinks.json" \
        --content-type "application/json" \
        --cache-control "max-age=300,public"
fi
# A placeholder Team ID must never reach the bucket. `TEAMID_PENDING` is the
# sentinel the committed file carries while the Apple Developer enrollment is
# pending (Apple Developer -> Membership -> Team ID issues the real one, ten
# uppercase alphanumerics, only once the enrollment is APPROVED). Published
# as-is the file parses, uploads, and is fetched successfully by Apple -- and
# every universal link silently keeps opening Safari, with no server-side trace
# and a weeks-long feedback loop. scripts/check-well-known.mjs asserts this
# refusal exists in all three deploy paths whether or not a file is in the tree.
if [[ -f frontend/dist/.well-known/apple-app-site-association ]] && \
    grep -q "TEAMID_PENDING" frontend/dist/.well-known/apple-app-site-association; then
    echo "frontend/dist/.well-known/apple-app-site-association still carries the placeholder Team ID TEAMID_PENDING." >&2
    echo "Refusing to publish it: see docs/mobile.md." >&2
    exit 1
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
# SNS-invoked SES bounce/complaint consumer; emailReplies is the SES-invoked
# reply-to-act consumer (#667); checkoutRecovery is the
# EventBridge abandoned-checkout recovery scan. Keep this list in sync
# with infrastructure/modules/api locals + the CD workflow's deploy loop.
HANDLERS=(auth plants tasks households me billing notifications species climate apiKeys api reminders chat digests emailEvents emailReplies checkoutRecovery chat-stream)
# Every function that did not end up running this build's code. The loop keeps
# going so one broken function does not leave the rest on the old release, but
# the script must not end by saying the deploy is complete when this is not
# empty — see the exit at the bottom.
FAILED_HANDLERS=()
for handler in "${HANDLERS[@]}"; do
    FUNCTION_NAME="family-greenhouse-${handler}-${ENVIRONMENT}"
    SRC="backend/dist/${handler}.js"

    # A missing bundle is a broken build, not a function to skip. Both CD
    # workflows exit 1 here; this used to print "Skipping" and carry on, so a
    # `dist/` that was half-built deployed a partial release and still finished
    # by announcing a complete one.
    if [[ ! -f "$SRC" ]]; then
        echo "  ✗ ${FUNCTION_NAME}: ${SRC} not found — the backend build did not produce it" >&2
        FAILED_HANDLERS+=("$handler")
        continue
    fi

    WORK=$(mktemp -d)
    cp "$SRC" "${WORK}/handler.mjs"
    # An `if`, not `[[ ... ]] && cp ... || true`. Errexit applies to the last
    # command of an `&&` list, so the bare `[[ ... ]] && cp` this replaces
    # returned 1 on a bundle built without a source map and killed the whole
    # script mid-deploy, after some functions had already been published. The
    # `|| true` both CD workflows use fixes that, but SC2015 fires on it under
    # the analyser version the CI runner ships and not under the newer one a
    # laptop may have, so the gate's verdict would depend on which machine ran
    # it. An `if` suspends errexit in its condition and reads the same to every
    # version.
    #
    # (And this comment does not begin a line with the analyser's own name:
    # that is read as a directive, and a malformed one silently stops the file
    # being checked at all — see the header of scripts/check-shell.mjs.)
    if [[ -f "${SRC}.map" ]]; then
        cp "${SRC}.map" "${WORK}/handler.mjs.map"
    fi
    ZIP="$(pwd)/.deploy-${handler}.zip"
    (cd "$WORK" && zip -q -r "$ZIP" .)

    # `if` rather than `A && B || C` (SC2015): in the `&&`/`||` form the failure
    # branch also runs when the UPDATE succeeded and the `echo` failed, which
    # would print "not found or update failed" for a Lambda that had just been
    # published and `continue` past the artifact archive below — leaving CD's
    # auto-rollback with no zip for a version that exists.
    #
    # stderr is NOT discarded. It used to be `2>/dev/null`, so the one line
    # saying WHY (a wrong profile, an expired session, a function this
    # environment does not have) was thrown away and the operator was left with
    # "not found or update failed" for all sixteen.
    if PUBLISHED_VER=$(aws lambda update-function-code \
        --function-name "$FUNCTION_NAME" \
        --region us-east-1 \
        --zip-file "fileb://${ZIP}" \
        --publish --query 'Version' --output text); then
        # Both CD workflows wait here. Without it the script returns while the
        # new code is still being applied, so a caller that immediately smokes
        # the API can be answered by the previous version, and a second update
        # to the same function races an in-progress one.
        aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME" --region us-east-1
        echo "  ✓ ${FUNCTION_NAME} (v${PUBLISHED_VER})"
    else
        echo "  ✗ ${FUNCTION_NAME} (update failed — see the error above)" >&2
        FAILED_HANDLERS+=("$handler")
        rm -rf "$WORK" "$ZIP"
        continue
    fi

    # Archive this version's zip so CD auto-rollback can restore it later.
    #
    # Not `|| true`. This archive IS the rollback: cd-production.yml restores a
    # previous version by fetching exactly this key, and a version that exists
    # in Lambda with no zip in S3 is a version the auto-rollback cannot go back
    # to. Swallowing the failure left that gap silently, on the manual path
    # that is used when something is already wrong.
    if ! aws s3 cp "$ZIP" \
        "s3://${ARTIFACT_BUCKET}/lambda-versions/${handler}-v${PUBLISHED_VER}.zip" \
        --region us-east-1 --only-show-errors; then
        echo "  ✗ ${FUNCTION_NAME}: v${PUBLISHED_VER} is live but its rollback package could not be archived" >&2
        FAILED_HANDLERS+=("$handler")
    fi

    rm -rf "$WORK" "$ZIP"
done

if [[ ${#FAILED_HANDLERS[@]} -gt 0 ]]; then
    echo "" >&2
    echo "Deployment to $ENVIRONMENT INCOMPLETE: ${#FAILED_HANDLERS[@]} of ${#HANDLERS[@]} functions did not deploy cleanly:" >&2
    printf '  %s\n' "${FAILED_HANDLERS[@]}" >&2
    echo "" >&2
    echo "The frontend above has already been published, so the site is now newer than these" >&2
    echo "functions. Fix the cause and re-run, or roll the frontend back by hand." >&2
    exit 1
fi

# Prove the API is actually serving, the same way both CD workflows do
# immediately after their own Lambda loop. A deploy that published every
# function and left the API answering 500 used to end with "complete!".
echo ""
echo "Smoke test: GET ${API_URL}/health"
HEALTH_CODE=$(curl -sS -o /tmp/fg-deploy-health.json -w "%{http_code}" "${API_URL}/health")
echo "  HTTP ${HEALTH_CODE}"
cat /tmp/fg-deploy-health.json
echo ""
if [[ "$HEALTH_CODE" != "200" ]]; then
    echo "Smoke test failed: the API did not answer 200 after this deploy." >&2
    exit 1
fi
node -e "const h=require('/tmp/fg-deploy-health.json'); if(h.status!=='ok'||h.components?.database?.status!=='ok') process.exit(1)" || {
    echo "Smoke test failed: /health answered 200 but did not report itself healthy." >&2
    exit 1
}

echo ""
echo "Deployment to $ENVIRONMENT complete!"
