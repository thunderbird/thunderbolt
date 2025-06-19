#!/bin/bash
set -euo pipefail

# Build Flower Intelligence TypeScript library using Bun

# Ensure the Flower submodule is present (clone if missing)
if [ ! -d "flower/intelligence/ts" ]; then
  echo "❌ Flower submodule not found. Attempting to initialise git submodules..."
  git submodule update --init --recursive
fi

# Build Flower Intelligence TypeScript library

echo "Building Flower Intelligence library..."

# Exit early if the directory still doesn't exist after attempting to init submodules
if [ ! -d "flower/intelligence/ts" ]; then
  echo "🔴 Directory flower/intelligence/ts still not found. Aborting Flower build."
  exit 1
fi

cd flower/intelligence/ts

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing Flower dependencies with Bun..."
    bun install
fi

# Build the library (uses the script defined in package.json)
echo "Building Flower with Bun..."
bun run vite build --config vite.config.bundled.ts

echo "Flower Intelligence build complete!"