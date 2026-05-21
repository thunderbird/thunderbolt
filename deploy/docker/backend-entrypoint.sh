#!/bin/sh

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -e

# Render preview deploys: append the preview URL to allowed CORS origins
if [ "$IS_PULL_REQUEST" = "true" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then
  export CORS_ORIGINS="${CORS_ORIGINS:+${CORS_ORIGINS},}${RENDER_EXTERNAL_URL}"
fi

# Shared-postgres preview model (THU-495): when POSTGRES_ADMIN_URL is set, this
# backend is one of many PR previews sharing a single Postgres instance. Each PR
# gets its own logical database named after the stack (e.g. `pr_846`). The Pulumi
# per-pr stack passes:
#   - DATABASE_URL: postgres://...:.../pr_846
#   - POSTGRES_ADMIN_URL: postgres://postgres:.../postgres   (admin on default DB)
# We connect to admin first, ensure the per-stack DB exists, then proceed with
# the normal wait + migrate + start flow against DATABASE_URL.
#
# Legacy stacks (POSTGRES_ADMIN_URL unset) skip this entirely: they have a
# dedicated Postgres container with the target DB pre-created at boot.
if [ -n "$POSTGRES_ADMIN_URL" ]; then
  WAIT_URL="$POSTGRES_ADMIN_URL"
else
  WAIT_URL="$DATABASE_URL"
fi

MAX_RETRIES=30
retries=0
echo "Waiting for database..."
until WAIT_URL="$WAIT_URL" bun -e "import postgres from 'postgres'; const sql = postgres(process.env.WAIT_URL); await sql\`SELECT 1\`; await sql.end(); process.exit(0)"; do
  retries=$((retries + 1))
  if [ "$retries" -ge "$MAX_RETRIES" ]; then
    echo "Database never became ready after $MAX_RETRIES attempts"
    exit 1
  fi
  echo "  database not ready, retrying in 3s... ($retries/$MAX_RETRIES)"
  sleep 3
done
echo "Database server is ready."

if [ -n "$POSTGRES_ADMIN_URL" ]; then
  echo "Ensuring per-stack database exists..."
  bun -e "
    import postgres from 'postgres'
    const target = new URL(process.env.DATABASE_URL)
    const dbName = target.pathname.replace(/^\//, '')
    if (!dbName || !/^[a-zA-Z0-9_]+\$/.test(dbName)) {
      console.error('Refusing CREATE DATABASE on invalid name:', dbName)
      process.exit(1)
    }
    const admin = postgres(process.env.POSTGRES_ADMIN_URL)
    const r = await admin\`SELECT 1 FROM pg_database WHERE datname = \${dbName}\`
    if (r.length === 0) {
      console.log('  creating', dbName)
      await admin.unsafe('CREATE DATABASE \"' + dbName + '\"')
    } else {
      console.log('  already exists:', dbName)
    }
    await admin.end()
  "
fi

echo "Running database migrations..."
bun drizzle-kit migrate

echo "Starting server..."
exec bun run src/index.ts
