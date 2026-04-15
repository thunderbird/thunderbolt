#!/bin/sh
set -e

# Render preview deploys: append the preview URL to allowed CORS origins
if [ "$IS_PULL_REQUEST" = "true" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then
  export CORS_ORIGINS="${CORS_ORIGINS:+${CORS_ORIGINS},}${RENDER_EXTERNAL_URL}"
fi

echo "Running database migrations..."
bun drizzle-kit migrate

echo "Starting server..."
exec bun run src/index.ts
