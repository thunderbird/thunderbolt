use anyhow::{anyhow, Result};
use assist_embeddings::{generate_all, generate_batch};
use libsql::{Builder, Connection};
use std::env;
use std::path::Path;

// Add this new function
async fn test_embedding_generation() -> Result<()> {
    println!("Testing embedding generation with a sample text...");

    // Import the get_embedding function directly
    let sample_text = "This is a test email to verify embedding generation works correctly.";
    let embedding = assist_embeddings::embedding::get_embedding(sample_text)?;

    println!(
        "Successfully generated embedding with {} dimensions",
        embedding.values.len()
    );
    // Print first few values of the embedding
    let preview: Vec<f32> = embedding.values.iter().take(5).cloned().collect();
    println!("First few values: {:?}", preview);

    Ok(())
}

async fn setup_database() -> Result<Connection> {
    // Get the current directory of the executable
    let current_dir = env::current_dir()?;
    println!("Current directory: {}", current_dir.display());

    // Try to find the right path to the database
    let db_paths = [
        // From root of the project
        Path::new("src-tauri/data/local.db"),
        // From src-tauri directory
        Path::new("data/local.db"),
        // From assist_embeddings directory
        Path::new("../data/local.db"),
    ];

    let mut db_path = None;

    for path in &db_paths {
        let absolute_path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            current_dir.join(path)
        };

        println!("Checking database path: {}", absolute_path.display());
        if absolute_path.exists() {
            println!("Found database at: {}", absolute_path.display());
            db_path = Some(absolute_path);
            break;
        }
    }

    // Use the first path as fallback if none exists
    let absolute_db_path = db_path.unwrap_or_else(|| {
        let fallback = current_dir.join(&db_paths[0]);
        println!(
            "No existing database found, using fallback path: {}",
            fallback.display()
        );
        fallback
    });

    // Connect to the database using Builder
    println!("Connecting to database at: {}", absolute_db_path.display());

    // Return early if database file doesn't exist
    if !absolute_db_path.exists() {
        return Err(anyhow!(
            "Database file does not exist at {}",
            absolute_db_path.display()
        ));
    }

    let db = Builder::new_local(absolute_db_path.to_str().unwrap())
        .build()
        .await?;

    let conn = db.connect()?;
    println!("Database connection established successfully");

    Ok(conn)
}

async fn process_embeddings(conn: &Connection) -> Result<()> {
    // Define batch size
    let batch_size = 10;

    // Option 1: Process a single batch
    println!(
        "Processing a single batch of up to {} messages...",
        batch_size
    );
    let processed = generate_batch(conn, batch_size).await?;
    println!("Processed {} messages in batch", processed);

    // Option 2: Process all messages
    println!("Processing all remaining messages...");
    let total_processed = generate_all(conn, batch_size).await?;
    println!("Processed a total of {} messages", total_processed);

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // First test embedding generation independently
    match test_embedding_generation().await {
        Ok(_) => println!("✅ Embedding generation test passed"),
        Err(e) => {
            println!("❌ Embedding generation test failed: {}", e);
            return Err(e);
        }
    }

    // Try to set up database connection
    match setup_database().await {
        Ok(conn) => {
            // Try to process embeddings
            match process_embeddings(&conn).await {
                Ok(_) => println!("✅ Database embeddings processing completed successfully"),
                Err(e) => println!("❌ Database embeddings processing failed: {}", e),
            }
        }
        Err(e) => {
            println!("❌ Database connection failed: {}", e);
            println!("Skipping embeddings processing, but embedding generation works correctly");
        }
    }

    Ok(())
}
