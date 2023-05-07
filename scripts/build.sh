#!/usr/bin/env bash

set -e
cd $(git rev-parse --show-toplevel)
npm --prefix=frontend run build

# Run backend build process if needed, but not with react-scripts

# Create backend/dist directory if it doesn't exist
mkdir -p backend/dist

# Move frontend build output to backend/dist
mv frontend/build/* backend/dist/
