# Assist Embeddings

This crate provides functionality for generating embeddings for email messages stored in a database.

## Features

- Generate embeddings for email messages in batches
- Store embeddings in the database for later retrieval
- Uses the Jina AI embedding model for high-quality text representations
- Generates UUIDs v7 for time-sorted unique identifiers

## Examples

### Generate Embeddings

The main example that processes email messages from the database:

```bash
# Make sure you're in the mozilla-assist root directory
cargo run --manifest-path=src-tauri/assist_embeddings/Cargo.toml --example generate_embeddings
```

This example will:
1. Test the embedding generation functionality with a sample text 
2. Connect to the local database at `src-tauri/data/local.db`
3. Process a single batch of messages (up to 10)
4. Process all remaining messages without embeddings

### Test Embeddings

A simple example that only tests the embedding generation:

```bash
cargo run --manifest-path=src-tauri/assist_embeddings/Cargo.toml --example test_embeddings
```

This example only tests the embedding functionality without requiring a database connection.

## Technical Details

The embedding model returns tensors with shape `[1, 768]`, but the `to_vec1()` method in Candle requires a 1-dimensional tensor. To solve this, we flatten the tensor before returning it from the embedding function, resulting in a shape of `[768]`.

## Structure

- `lib.rs`: Main library code with database operations
- `embedding.rs`: Embedding generation using Jina AI model
- `examples/`: Example applications demonstrating the functionality 