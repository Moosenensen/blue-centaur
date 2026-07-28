#!/bin/bash
set -e

npm install --legacy-peer-deps

# Apply the Drizzle schema (source of truth) to the development database so a
# merge lands any schema changes. Non-interactive; prod is updated via Publish.
npm run db:push -- --force

# No explicit server restart needed here: the dev workflow runs under nodemon
# watching src/, so merged .ts changes trigger an automatic reload. (Static
# files under src/web are served from disk per-request and need no restart.)
