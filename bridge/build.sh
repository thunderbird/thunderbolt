#!/bin/bash

# Build script for Thunderbolt Bridge extension

echo "Building Thunderbolt Bridge extension..."

# Create build directory
mkdir -p ../dist

# Create the XPI file
cd "$(dirname "$0")"
zip -r ../dist/thunderbolt-bridge.xpi . \
  -x "*.DS_Store" \
  -x "build.sh" \
  -x ".git/*"

echo "Extension built: ../dist/thunderbolt-bridge.xpi"