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
