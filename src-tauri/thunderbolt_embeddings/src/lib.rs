use anyhow::Result;
use libsql::{Connection, Value};
use serde::{Deserialize, Serialize};

// Make the embedding module public so it can be used in examples
pub mod commands;
pub mod embedding;

use embedding::{generate_embedding, Embedder};

// Re-export the commands and state
pub use commands::{generate_embeddings, init_embedder, EmbeddingsState};

#[derive(Debug, Serialize, Deserialize)]
struct EmailMessage {
    id: String,
    text_body: String,
}

pub async fn generate_batch_with_embedder(
    conn: &Connection,
    count: usize,
    embedder: &Embedder,
) -> Result<usize> {
    // Query to find messages without embeddings
    let query = r#"
        SELECT m.id, m.text_body
        FROM email_messages m
        LEFT JOIN embeddings e ON m.id = e.email_message_id
        WHERE e.email_message_id IS NULL AND m.text_body IS NOT NULL AND m.text_body != ''
        LIMIT ?
    "#;

    let mut stmt = conn.prepare(query).await?;
    let mut rows = stmt.query([count as i64]).await?;

    let mut processed = 0;
    let mut messages = Vec::new();

    while let Some(row) = rows.next().await? {
        let id: String = row.get(0)?;
        let text_body: String = row.get(1)?;

        if !text_body.is_empty() {
            messages.push((id, text_body));
        }
    }

    for (id, text_body) in messages {
        // Generate the embedding using our shared embedder that automatically truncates long text
        let embedding = generate_embedding(embedder, &text_body)?;

        // Convert Vec<f32> to binary data
        let embedding_bytes: Vec<u8> = embedding
            .iter()
            .flat_map(|&val| val.to_le_bytes().to_vec())
            .collect();

        // Prepare the upsert statement for embeddings
        let upsert_query = r#"
            INSERT INTO embeddings (id, email_message_id, embedding)
            VALUES (?, ?, ?)
            ON CONFLICT(email_message_id) DO UPDATE SET embedding = excluded.embedding
        "#;

        let mut stmt = conn.prepare(upsert_query).await?;

        // Generate a unique ID for the embedding using UUID v7
        // This automatically uses the current timestamp
        let embedding_id = uuid::Uuid::now_v7().to_string();

        // Use proper value types for parameters
        let params = vec![
            Value::Text(embedding_id),
            Value::Text(id),
            Value::Blob(embedding_bytes),
        ];
        stmt.execute(params).await?;

        processed += 1;
    }

    Ok(processed)
}

pub async fn generate_all_with_embedder(
    conn: &Connection,
    batch_size: usize,
    embedder: &Embedder,
) -> Result<usize> {
    let mut total_processed = 0;
    let mut processed_in_batch;

    loop {
        processed_in_batch = generate_batch_with_embedder(conn, batch_size, embedder).await?;
        total_processed += processed_in_batch;

        if processed_in_batch == 0 {
            break;
        }
    }

    Ok(total_processed)
}
