use anyhow::Result;
use mistralrs::{IsqType, TextMessageRole, TextMessages, TextModelBuilder};
use serde::Deserialize;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct Message {
    clean_text: String,
}

// Note: this must be built with "--release" in order to work. If you run it without building for release, it will just hang.
#[tokio::main]
async fn main() -> Result<()> {
    // Get input file path from env var or use default
    let input_file =
        std::env::var("INPUT_FILE").unwrap_or_else(|_| "data/sample-messages.json".to_string());

    // Read and parse the JSON file
    let json_str = std::fs::read_to_string(input_file)?;
    let messages: Vec<Message> = serde_json::from_str(&json_str)?;

    // Initialize model once
    let model = TextModelBuilder::new("meta-llama/Llama-3.2-1B-Instruct")
        .with_isq(IsqType::Q4K)
        .with_logging()
        .build()
        .await?;

    println!("Model loaded");

    let start_time = Instant::now();
    let mut total_duration = Duration::from_secs(0);

    for (i, message) in messages.iter().enumerate() {
        if message.clean_text.is_empty() {
            println!("Skipping message {i} - empty text");
            continue;
        }

        let msg_start = Instant::now();

        let messages = TextMessages::new()
            .add_message(
                TextMessageRole::System,
                "You are a helpful AI assistant. Please summarize the following text in 2-3 sentences.",
            )
            .add_message(TextMessageRole::User, &message.clean_text);

        match model.send_chat_request(messages).await {
            Ok(response) => {
                let summary = response.choices[0].message.content.as_ref().unwrap();
                let duration = msg_start.elapsed();
                total_duration += duration;

                println!(
                    "Message {i} ({} chars) took {:.2?}\nSummary: {}\n",
                    message.clean_text.len(),
                    duration,
                    summary
                );
            }
            Err(e) => {
                println!("Error processing message {i}: {}", e);
                continue;
            }
        }
    }

    println!("\nTotal time: {:.2?}", start_time.elapsed());
    println!(
        "Average time: {:.2?}",
        total_duration / messages.len() as u32
    );

    Ok(())
}
