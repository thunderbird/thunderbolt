use anyhow::Error as E;
use candle::{DType, Module, Tensor};
use candle_core as candle;
use candle_nn::VarBuilder;
use candle_transformers::models::jina_bert::{BertModel, Config, PositionEmbeddingType};
use hf_hub::{api::sync::Api, Repo, RepoType};

pub fn get_embedding(text: &str) -> anyhow::Result<Tensor> {
    let device = candle::Device::Cpu;

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

    // Tokenize input
    let tokens = tokenizer
        .encode(text, true)
        .map_err(E::msg)?
        .get_ids()
        .to_vec();
    let token_ids = Tensor::new(&tokens[..], &device)?.unsqueeze(0)?;

    // Get embeddings
    let embeddings = model.forward(&token_ids)?;
    let (_n_sentence, n_tokens, _hidden_size) = embeddings.dims3()?;
    let embeddings = (embeddings.sum(1)? / (n_tokens as f64))?;

    // Normalize embeddings
    let normalized = normalize_l2(&embeddings)?;

    Ok(normalized)
}

fn normalize_l2(v: &Tensor) -> candle::Result<Tensor> {
    v.broadcast_div(&v.sqr()?.sum_keepdim(1)?.sqrt()?)
}
