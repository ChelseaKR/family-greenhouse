#!/usr/bin/env bash

cd $(git rev-parse --show-toplevel)

set -e

npm --prefix=frontend run test
npm --prefix=backend run test

cd frontend/
npx cypress run