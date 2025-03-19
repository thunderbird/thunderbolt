#!/bin/bash

# Navigate to the mozilla-assist root directory (where this repo is cloned)
cd "$(dirname "$0")/../.." || exit

# Build and run the example
echo "Building and running embedding generation example..."
cargo run --manifest-path=src-tauri/assist_embeddings/Cargo.toml --example generate_embeddings

echo "Done!" 