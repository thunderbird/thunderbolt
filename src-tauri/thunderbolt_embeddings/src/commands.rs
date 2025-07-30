use anyhow::Result;
use std::sync::Arc;
use tauri::{command, State};
use tokio::sync::Mutex;

use crate::embedding::Embedder;

/// Application state for the embeddings functionality
#[derive(Default)]
pub struct EmbeddingsState {
    pub embedder: Option<Arc<Embedder>>,
}

#[command]
pub async fn init_embedder(state: State<'_, Mutex<EmbeddingsState>>) -> Result<(), String> {
    // Initialize the embedder
    let embedder = Embedder::new().map_err(|e| format!("Failed to initialize embedder: {e}"))?;

    // Store the embedder in state wrapped in an Arc for thread safety
    let mut state_guard = state.lock().await;
    state_guard.embedder = Some(Arc::new(embedder));

    Ok(())
}

#[command]
pub async fn generate_embeddings(
    state: State<'_, Mutex<EmbeddingsState>>,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>, String> {
    // Get a cloned Arc to the embedder from state
    let embedder_arc = {
        let state_guard = state.lock().await;

        // Check if the embedder has been initialized
        match &state_guard.embedder {
            Some(embedder) => embedder.clone(), // Clone the Arc, not the embedder
            None => return Err("Embedder not initialized".to_string()),
        }
    };

    // Clone the texts to use in the task
    let texts_clone = texts.clone();

    // Spawn a blocking task with the Arc-wrapped embedder
    let embeddings = tokio::task::spawn_blocking(move || {
        // Use the Arc-wrapped embedder with the arc-specific function
        crate::embedding::generate_embeddings_arc(&embedder_arc, &texts_clone)
            .map_err(|e| format!("Failed to generate embeddings: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?;

    embeddings
}
