#!/usr/bin/env bash
# Xcode Cloud post-clone step (docs/mobile.md, "Xcode Cloud").
#
# CapApp-SPM/Package.swift resolves every Capacitor plugin from the repo-root
# node_modules, and the app bundles frontend/dist through `cap sync`. A fresh
# Xcode Cloud clone has neither, so package resolution failed on every build.
# This does what `npm run mobile:release` does locally for iOS: install Node,
# `npm ci`, the production web build, `npx cap sync ios`.
#
# Xcode Cloud only runs this file from a ci_scripts/ directory next to
# App.xcodeproj, so it has to live here.
set -euo pipefail

REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
FRONTEND_DIR="$REPO_ROOT/frontend"
NODE_MAJOR="$(tr -d '[:space:]v' < "$REPO_ROOT/.nvmrc")"

# Node, pinned to the major in .nvmrc. Homebrew ships on the Xcode Cloud image.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]]; then
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
  brew install "node@$NODE_MAJOR"
  NODE_PREFIX="$(brew --prefix "node@$NODE_MAJOR")"
  export PATH="$NODE_PREFIX/bin:$PATH"
fi
echo "Using node $(node --version), npm $(npm --version)"

# Production build variables. Every value in the committed template is public
# client configuration, so nothing here is a secret. A variable set in the
# Xcode Cloud workflow's Environment section wins over the template.
# Native push is on for iOS store builds (4001 onward), as in the local
# .env.mobile.production; the template has to say false for the validator.
export VITE_NATIVE_PUSH_ENABLED="${VITE_NATIVE_PUSH_ENABLED:-true}"
while IFS='=' read -r key value; do
  [[ "$key" =~ ^VITE_[A-Z0-9_]+$ ]] || continue
  if [[ -z "${!key+x}" ]]; then export "$key=$value"; fi
done < "$FRONTEND_DIR/.env.mobile.production.example"

cd "$REPO_ROOT"
npm ci --no-audit --no-fund
node scripts/validate-store-release.mjs --production

cd "$FRONTEND_DIR"
MOBILE_STORE_BUILD=true npm run build
# vite-plugin-pwa may emit Workbox maps independently of Vite's build flag.
find "$FRONTEND_DIR/dist" -type f -name '*.map' -delete
npx cap sync ios

# The validator's --synced mode also wants the Android copy, which this build
# does not make, so check the iOS half directly: the bundle reached the app
# and carries the production API URL.
if ! grep -rqF "$VITE_API_URL" "$FRONTEND_DIR/ios/App/App/public"; then
  echo "frontend/ios/App/App/public lacks VITE_API_URL; cap sync or the build env failed" >&2
  exit 1
fi
echo "Production web bundle synced into the iOS project."
