#!/bin/sh
set -e

echo "Running database migrations..."
bun drizzle-kit migrate

echo "Starting server..."
exec bun run src/index.ts
