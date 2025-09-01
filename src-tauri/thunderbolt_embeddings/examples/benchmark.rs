use anyhow::Result;
use std::time::Instant;
use thunderbolt_embeddings::embedding::{generate_embedding, generate_embeddings, Embedder};

fn main() -> Result<()> {
    println!("Initializing embedder...");
    let start = Instant::now();
    let embedder = Embedder::new()?;
    println!("Embedder initialized in {:.2?}", start.elapsed());

    // Create test data
    let text = "This is a test document for embedding generation. It contains multiple sentences to ensure we have enough content to test with. The model should process this text and generate embeddings based on its contents.";

    // Generate varying sizes of test data
    let sizes = [1, 10, 50, 100, 200];

    println!("\nRunning sequential processing benchmark:");
    for &size in &sizes {
        let mut texts = Vec::with_capacity(size);
        for i in 0..size {
            texts.push(format!("{} This is document number {}.", text, i));
        }

        println!("\nProcessing {} texts sequentially:", size);
        let start = Instant::now();

        for t in &texts {
            let _embedding = generate_embedding(&embedder, t)?;
        }

        let elapsed = start.elapsed();
        println!("Sequential processing completed in {:.2?}", elapsed);
        println!("Average time per text: {:.2?}", elapsed / size as u32);
    }

    println!("\nRunning batch processing benchmark:");
    for &size in &sizes {
        let mut texts = Vec::with_capacity(size);
        for i in 0..size {
            texts.push(format!("{} This is document number {}.", text, i));
        }

        println!("\nProcessing {} texts in batches:", size);
        let start = Instant::now();

        let _embeddings = generate_embeddings(&embedder, &texts)?;

        let elapsed = start.elapsed();
        println!("Batch processing completed in {:.2?}", elapsed);
        println!("Average time per text: {:.2?}", elapsed / size as u32);

        if size > 1 {
            // Calculate speedup
            let sequential_time = elapsed.as_secs_f64() * (size as f64) / 1.0; // Estimate based on single text time
            let batch_time = elapsed.as_secs_f64();
            let speedup = sequential_time / batch_time;
            println!("Estimated speedup vs sequential: {:.2}x", speedup);
        }
    }

    Ok(())
}
