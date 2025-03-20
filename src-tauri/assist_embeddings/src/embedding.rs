use anyhow::Error as E;
use candle::{DType, Module, Tensor};
use candle_core as candle;
use candle_nn::VarBuilder;
use candle_transformers::models::jina_bert::{BertModel, Config, PositionEmbeddingType};
use hf_hub::{api::sync::Api, Repo, RepoType};
use std::sync::OnceLock;

pub struct Embedder {
    model: BertModel,
    tokenizer: tokenizers::Tokenizer,
    device: candle::Device,
}

static EMBEDDER: OnceLock<Embedder> = OnceLock::new();

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

pub fn get_embedding(text: &str) -> anyhow::Result<Vec<f32>> {
    let embedder = EMBEDDER.get_or_init(|| Embedder::new().unwrap());
    get_embedding_with_embedder(embedder, text)
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
