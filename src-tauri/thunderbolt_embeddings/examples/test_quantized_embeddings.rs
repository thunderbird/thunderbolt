use std::time::Instant;
use thunderbolt_embeddings::embedding::{generate_embedding, Embedder};

fn main() -> anyhow::Result<()> {
    println!("Initializing quantized embedder...");
    let start = Instant::now();
    let embedder = Embedder::new()?;
    let init_time = start.elapsed();
    println!("Embedder initialized in {:?}", init_time);

    // Test with a simple text sample
    let text = "This is a sample text to test the quantized embedding model.";
    println!("Generating embedding for: '{}'", text);

    let embedding_start = Instant::now();
    let embedding = generate_embedding(&embedder, text)?;
    let embedding_time = embedding_start.elapsed();

    // Print first 5 values of the embedding vector to check quality
    println!(
        "First 5 values of the embedding vector: {:?}",
        &embedding[..5]
    );
    println!("Embedding generated in {:?}", embedding_time);
    println!("Embedding vector length: {}", embedding.len());

    // Test performance on a batch of texts
    let texts = vec![
        "The quick brown fox jumps over the lazy dog.",
        "Quantization helps reduce model size and improve inference speed.",
        "The embedding model can be used for semantic search and clustering.",
        "Thunderbolt processes emails for better productivity.",
        "Testing the performance of quantized embeddings.",
    ];

    println!("\nTesting batch embedding with {} texts...", texts.len());
    let batch_start = Instant::now();

    for text in &texts {
        let _ = generate_embedding(&embedder, text)?;
    }

    let batch_time = batch_start.elapsed();
    println!(
        "Batch processed in {:?} ({:?} per text)",
        batch_time,
        batch_time.div_f32(texts.len() as f32)
    );

    Ok(())
}
