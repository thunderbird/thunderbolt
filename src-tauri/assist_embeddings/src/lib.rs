use anyhow::Result;
use libsql::{Connection, Value};
use serde::{Deserialize, Serialize};
use serde_json;

// Make the embedding module public so it can be used in examples
pub mod embedding;
use embedding::get_embedding;

#[derive(Debug, Serialize, Deserialize)]
struct EmailMessage {
    id: String,
    text_body: String,
}

pub async fn generate_batch(conn: &Connection, count: usize) -> Result<usize> {
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
        let embedding = get_embedding(&text_body)?;
        let embedding_json = serde_json::to_string(&embedding)?;

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
            Value::Text(embedding_json),
        ];
        stmt.execute(params).await?;

        processed += 1;
    }

    Ok(processed)
}

pub async fn generate_all(conn: &Connection, batch_size: usize) -> Result<usize> {
    let mut total_processed = 0;
    let mut processed_in_batch;

    loop {
        processed_in_batch = generate_batch(conn, batch_size).await?;
        total_processed += processed_in_batch;

        if processed_in_batch == 0 {
            break;
        }
    }

    Ok(total_processed)
}
