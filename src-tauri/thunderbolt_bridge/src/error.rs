use thiserror::Error;

#[derive(Error, Debug)]
pub enum BridgeError {
    #[error("WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Bridge not connected")]
    NotConnected,

    #[error("Invalid message format")]
    InvalidMessage,

    #[error("MCP error: {0}")]
    Mcp(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Other error: {0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, BridgeError>;

impl From<anyhow::Error> for BridgeError {
    fn from(err: anyhow::Error) -> Self {
        BridgeError::Other(err.to_string())
    }
}
