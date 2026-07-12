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
# shellcheck disable=SC1090 -- the caller intentionally selects this local env file.
source "$ENV_FILE"
set +a

cd "$REPO_ROOT"
node scripts/validate-store-release.mjs --production

cd "$FRONTEND_DIR"
MOBILE_STORE_BUILD=true npm run build
# vite-plugin-pwa may emit Workbox maps independently of Vite's build flag.
find "$FRONTEND_DIR/dist" -type f -name '*.map' -delete
npx cap sync

cd "$REPO_ROOT"
node scripts/validate-store-release.mjs --production --synced

echo "Production web assets are validated and synchronized into both native projects."

if [[ -n "${JAVA_HOME:-}" && -x "$FRONTEND_DIR/android/gradlew" ]]; then
  (
    cd "$FRONTEND_DIR/android"
    ./gradlew bundleRelease
  )
  echo "Unsigned Android release bundle built. Use the upload keystore to sign it before Play upload."
else
  echo "JAVA_HOME is not set; skipped Android bundleRelease."
fi

echo "Next: sign the Android AAB and archive the iOS app in Xcode."
