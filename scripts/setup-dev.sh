#!/bin/bash
set -e

echo "Setting up Family Greenhouse development environment..."

# Check Node.js version
REQUIRED_NODE_VERSION=20
CURRENT_NODE_VERSION=$(node -v | cut -d. -f1 | tr -d 'v')

if [ "$CURRENT_NODE_VERSION" -lt "$REQUIRED_NODE_VERSION" ]; then
    echo "Error: Node.js version $REQUIRED_NODE_VERSION or higher is required."
    echo "Current version: $(node -v)"
    exit 1
fi

echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"

# Install dependencies.
# `npm ci`, not `npm install`: ci installs the exact tree package-lock.json
# pins, which is what CI runs and what OpenSSF Scorecard's pinned-dependencies
# check wants. `npm install` is free to resolve a newer in-range version and
# rewrite the lockfile, so a fresh dev environment could silently differ from
# the one CI validated. If this step fails because package.json and the lock
# have drifted apart, that is the bug — regenerate the lockfile and commit it.
echo "Installing dependencies..."
npm ci

# Set up Husky hooks
echo "Setting up Git hooks..."
npm run prepare

# Install gitleaks.
#
# `npm run verify` HARD-FAILS without it (scripts/check-secrets.mjs), on
# purpose: the pre-commit hook soft-skips the secret scan when the binary is
# absent, and until #442 there was no signal anywhere that the scan was off —
# a contributor could work for months believing they were covered. A gate that
# silently turns itself off is the defect this repo keeps finding in its own
# tooling, so the binary is a real dependency now rather than an optional one.
GITLEAKS_VERSION=8.30.1
if command -v gitleaks >/dev/null 2>&1; then
    echo "gitleaks: $(gitleaks version) (CI pins ${GITLEAKS_VERSION})"
elif command -v brew >/dev/null 2>&1; then
    echo "Installing gitleaks..."
    brew install gitleaks
else
    echo "Error: gitleaks is not installed and Homebrew is not available."
    echo "The secret scan in 'npm run verify' cannot run without it, and it"
    echo "refuses to skip itself. Install it, then re-run this script:"
    echo "  https://github.com/gitleaks/gitleaks#installing  (pin v${GITLEAKS_VERSION})"
    exit 1
fi

# Install shellcheck.
#
# `npm run verify` HARD-FAILS without it (scripts/check-shell.mjs). The scripts
# it covers include one that deletes S3 object versions on the production
# release path, and a checker that skips itself when its tool is absent is a
# gate that cannot fail (#443).
if command -v shellcheck >/dev/null 2>&1; then
    echo "shellcheck: $(shellcheck --version | awk '/^version:/ {print $2}')"
elif command -v brew >/dev/null 2>&1; then
    echo "Installing shellcheck..."
    brew install shellcheck
elif command -v apt-get >/dev/null 2>&1; then
    echo "Installing shellcheck..."
    sudo apt-get install -y shellcheck
else
    echo "Error: shellcheck is not installed and no supported package manager was found."
    echo "The shell lint in 'npm run verify' cannot run without it, and it refuses"
    echo "to skip itself. Install it, then re-run this script:"
    echo "  https://github.com/koalaman/shellcheck#installing"
    exit 1
fi

# Create environment files if they don't exist
if [ ! -f "frontend/.env" ]; then
    echo "Creating frontend/.env..."
    cat > frontend/.env << EOF
VITE_API_URL=http://localhost:4000
VITE_COGNITO_USER_POOL_ID=local
VITE_COGNITO_CLIENT_ID=local
VITE_COGNITO_REGION=us-east-1
EOF
fi

echo ""
echo "Setup complete!"
echo ""
echo "To start development:"
echo "  1. Start the backend: cd backend && npm run dev"
echo "  2. Start the frontend: cd frontend && npm run dev"
echo ""
echo "The frontend will be available at http://localhost:3000"
echo "The backend will be available at http://localhost:4000"
