use anyhow::Error as E;
use candle::{DType, Module, Tensor};
use candle_core as candle;
use candle_nn::VarBuilder;
use candle_transformers::models::jina_bert::{BertModel, Config, PositionEmbeddingType};
use hf_hub::{api::sync::Api, Repo, RepoType};

pub struct Embedder {
    model: BertModel,
    tokenizer: tokenizers::Tokenizer,
    device: candle::Device,
}

impl Embedder {
    pub fn new() -> anyhow::Result<Self> {
        // Initialize Metal device instead of CPU
        let device = candle::Device::new_metal(0)?;

        // Get model and tokenizer files
        let model_name = "jinaai/jina-embeddings-v2-base-en";
        let api = Api::new()?;
        let model = api
            .repo(Repo::new(model_name.to_string(), RepoType::Model))
            .get("model.safetensors")?;
        let tokenizer_path = api
            .repo(Repo::new(model_name.to_string(), RepoType::Model))
            .get("tokenizer.json")?;

        // Initialize tokenizer
        let tokenizer = tokenizers::Tokenizer::from_file(tokenizer_path).map_err(E::msg)?;

        // Initialize model
        let config = Config::new(
            tokenizer.get_vocab_size(true),
            768,
            12,
            12,
            3072,
            candle_nn::Activation::Gelu,
            8192,
            2,
            0.02,
            1e-12,
            0,
            PositionEmbeddingType::Alibi,
        );

        let vb = unsafe { VarBuilder::from_mmaped_safetensors(&[model], DType::F32, &device)? };
        let model = BertModel::new(vb, &config)?;

        Ok(Self {
            model,
            tokenizer,
            device,
        })
    }

    pub fn get_embedding(&self, text: &str) -> anyhow::Result<Tensor> {
        // Tokenize input with truncation
        let encoding = self.tokenizer.encode(text, true).map_err(E::msg)?;
        let max_tokens = 8192; // Maximum context window for Jina embeddings model

        // Always truncate to max length for simplicity and consistency
        let token_ids = if encoding.get_ids().len() > max_tokens {
            encoding.get_ids()[0..max_tokens].to_vec()
        } else {
            encoding.get_ids().to_vec()
        };

        let token_ids = Tensor::new(&token_ids[..], &self.device)?.unsqueeze(0)?;

        // Get embeddings
        let embeddings = self.model.forward(&token_ids)?;
        let (_n_sentence, n_tokens, _hidden_size) = embeddings.dims3()?;
        let embeddings = (embeddings.sum(1)? / (n_tokens as f64))?;

        // Normalize and flatten embeddings
        let normalized = normalize_l2(&embeddings).map_err(E::msg)?;
        normalized.flatten_all().map_err(E::msg)
    }
}

pub fn get_embedding_with_embedder(embedder: &Embedder, text: &str) -> anyhow::Result<Vec<f32>> {
    let tensor = embedder.get_embedding(text)?;

    // Convert tensor to Vec<f32> and map the error type to anyhow
    tensor.to_vec1().map_err(|e| anyhow::Error::new(e))
}

fn normalize_l2(v: &Tensor) -> candle::Result<Tensor> {
    // Simple normalization that works with the expected tensor shape
    v.broadcast_div(&v.sqr()?.sum_keepdim(1)?.sqrt()?)
}

pub fn get_embeddings_with_embedder(
    embedder: &Embedder,
    texts: &[String],
) -> anyhow::Result<Vec<Vec<f32>>> {
    // Use the whole vector as input, with a reasonable maximum batch size
    // to prevent memory issues with extremely large vectors
    let max_batch_size = 50;
    let mut results = Vec::with_capacity(texts.len());

    // Process in reasonable chunks if the input is very large
    for chunk in texts.chunks(max_batch_size) {
        if chunk.len() == 1 {
            // Single item case, use the existing function to avoid complexity
            let embedding = get_embedding_with_embedder(embedder, &chunk[0])?;
            results.push(embedding);
            continue;
        }

        // Tokenize all texts in batch
        let mut token_ids_batch = Vec::with_capacity(chunk.len());
        let max_tokens = 8192; // Maximum context window for model

        for text in chunk {
            // Tokenize with truncation for each text - using as_str() to fix the trait bound issue
            let encoding = embedder
                .tokenizer
                .encode(text.as_str(), true)
                .map_err(E::msg)?;
            let token_ids = if encoding.get_ids().len() > max_tokens {
                encoding.get_ids()[0..max_tokens].to_vec()
            } else {
                encoding.get_ids().to_vec()
            };
            token_ids_batch.push(token_ids);
        }

        // Process each tokenized input separately but more efficiently than individual calls
        for token_ids in token_ids_batch {
            let token_tensor = Tensor::new(&token_ids[..], &embedder.device)?.unsqueeze(0)?;

            // Get embeddings
            let embeddings = embedder.model.forward(&token_tensor)?;
            let (_n_sentence, n_tokens, _hidden_size) = embeddings.dims3()?;
            let embeddings = (embeddings.sum(1)? / (n_tokens as f64))?;

            // Normalize and flatten embeddings
            let normalized = normalize_l2(&embeddings).map_err(E::msg)?;
            let flattened = normalized.flatten_all().map_err(E::msg)?;

            // Convert to Vec<f32> and store
            let embedding_vec = flattened.to_vec1().map_err(|e| anyhow::Error::new(e))?;
            results.push(embedding_vec);
        }
    }

    Ok(results)
}
