#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"
ENV_FILE="${1:-$FRONTEND_DIR/.env.mobile.production}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing mobile release environment: $ENV_FILE" >&2
  echo "Copy .env.mobile.production.example, fill it locally, and never commit it." >&2
  exit 1
fi

set -a
# The caller intentionally selects this local env file.
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$REPO_ROOT"
node scripts/validate-store-release.mjs --production

BUILD_ANDROID=false
if [[ -n "${JAVA_HOME:-}" && -x "$FRONTEND_DIR/android/gradlew" ]]; then
  BUILD_ANDROID=true
  # Fails before the slow web build when any ANDROID_UPLOAD_* variable is
  # missing, unless ALLOW_UNSIGNED_RELEASE=1 opts into an unsigned smoke build.
  node scripts/check-android-release-signing.mjs preflight
fi

cd "$FRONTEND_DIR"
MOBILE_STORE_BUILD=true npm run build
# vite-plugin-pwa may emit Workbox maps independently of Vite's build flag.
find "$FRONTEND_DIR/dist" -type f -name '*.map' -delete
npx cap sync

cd "$REPO_ROOT"
node scripts/validate-store-release.mjs --production --synced

echo "Production web assets are validated and synchronized into both native projects."

if [[ "$BUILD_ANDROID" == true ]]; then
  (
    cd "$FRONTEND_DIR/android"
    ./gradlew bundleRelease
  )
  # Prints whether the AAB is signed and with which key alias, checked with
  # jarsigner -verify; fails on an unsigned bundle unless explicitly allowed.
  node scripts/check-android-release-signing.mjs verify \
    "$FRONTEND_DIR/android/app/build/outputs/bundle/release/app-release.aab"
else
  echo "JAVA_HOME is not set; skipped Android bundleRelease."
fi

echo "Next: upload the verified Android AAB to Play and archive the iOS app in Xcode."
