#!/bin/sh

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -e

# Render preview deploys: append the preview URL to allowed CORS origins
if [ "$IS_PULL_REQUEST" = "true" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then
  export CORS_ORIGINS="${CORS_ORIGINS:+${CORS_ORIGINS},}${RENDER_EXTERNAL_URL}"
fi

MAX_RETRIES=30
retries=0
echo "Waiting for database..."
until bun -e "import postgres from 'postgres'; const sql = postgres(process.env.DATABASE_URL); await sql\`SELECT 1\`; await sql.end(); process.exit(0)"; do
  retries=$((retries + 1))
  if [ "$retries" -ge "$MAX_RETRIES" ]; then
    echo "Database never became ready after $MAX_RETRIES attempts"
    exit 1
  fi
  echo "  database not ready, retrying in 3s... ($retries/$MAX_RETRIES)"
  sleep 3
done
echo "Database is ready."

echo "Running database migrations..."
bun drizzle-kit migrate

echo "Starting server..."
exec bun run src/index.ts
