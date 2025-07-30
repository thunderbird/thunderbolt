use anyhow::Result;
use std::time::Instant;
use thunderbolt_embeddings::embedding::{generate_embeddings, Embedder};

fn main() -> Result<()> {
    println!("Initializing embedder...");
    let start = Instant::now();
    let embedder = Embedder::new()?;
    println!("Embedder initialized in {:.2?}", start.elapsed());

    // Generate some test data with varying length
    let mut texts = Vec::new();

    // Add short texts
    for i in 0..100 {
        texts.push(format!("This is a short test sentence number {}", i));
    }

    // Add medium texts
    for i in 0..50 {
        texts.push(format!("This is a medium length test paragraph. It contains several sentences with some information. The information is not particularly meaningful, but it serves as a good test case. This is test paragraph number {}.", i));
    }

    // Add a few long texts
    for i in 0..10 {
        let mut long_text = String::new();
        for j in 0..20 {
            long_text.push_str(&format!("This is part {} of a long document number {}. It contains multiple paragraphs and sentences to test the embedding generation with longer text inputs. ", j, i));
        }
        texts.push(long_text);
    }

    println!("Generated {} test texts", texts.len());

    // Benchmark embedding generation
    let start = Instant::now();
    let embeddings = generate_embeddings(&embedder, &texts)?;
    let elapsed = start.elapsed();

    println!(
        "Generated {} embeddings in {:.2?}",
        embeddings.len(),
        elapsed
    );
    println!(
        "Average time per embedding: {:.2?}",
        elapsed / texts.len() as u32
    );

    // Verify embeddings
    println!("Sample embedding dimensions: {}", embeddings[0].len());

    // Calculate cosine similarity between first two embeddings as a sanity check
    let sim = cosine_similarity(&embeddings[0], &embeddings[1]);
    println!("Cosine similarity between first two embeddings: {:.4}", sim);

    Ok(())
}

// Simple cosine similarity function for verification
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }

    let mut dot_product = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;

    for i in 0..a.len() {
        dot_product += (a[i] * b[i]) as f64;
        norm_a += (a[i] * a[i]) as f64;
        norm_b += (b[i] * b[i]) as f64;
    }

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    (dot_product / (norm_a.sqrt() * norm_b.sqrt())) as f32
}
