use anyhow::Result;
use mistralrs::{IsqType, TextMessageRole, TextMessages, TextModelBuilder};

// Note: this must be built with "--release" in order to work. If you run it without building for release, it will just hang.
#[tokio::main]
async fn main() -> Result<()> {
    let model = TextModelBuilder::new("meta-llama/Llama-3.2-1B-Instruct")
        .with_isq(IsqType::Q4K)
        .with_logging()
        // Causes it to hang / timeout - may be an issue with Metal
        // .with_paged_attn(|| {
        //     PagedAttentionMetaBuilder::default()
        //         .with_gpu_memory(MemoryGpuConfig::MbAmount(512))
        //         .build()
        // })
        // .unwrap()
        //
        // Also causes it to hang / timeout - may be an issue with Metal
        // .with_paged_attn(|| PagedAttentionMetaBuilder::default().build())?
        .build()
        .await?;

    println!("Model loaded");

    let messages = TextMessages::new()
        .add_message(
            TextMessageRole::System,
            "You are an AI agent with a specialty in programming.",
        )
        .add_message(
            TextMessageRole::User,
            "Hello! How are you? Please write generic binary search function in Rust.",
        );

    println!("--- Processing Prompt ---");

    let response = model.send_chat_request(messages).await?;

    println!("{}", response.choices[0].message.content.as_ref().unwrap());

    dbg!(
        response.usage.avg_prompt_tok_per_sec,
        response.usage.avg_compl_tok_per_sec
    );

    Ok(())
}
