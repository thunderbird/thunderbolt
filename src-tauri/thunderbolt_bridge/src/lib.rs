pub mod bridge;
pub mod error;
pub mod mcp;
pub mod websocket;

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

pub use error::{BridgeError, Result};

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub websocket_addr: SocketAddr,
    pub mcp_addr: SocketAddr,
    pub enabled: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            websocket_addr: ([127, 0, 0, 1], 9001).into(),
            mcp_addr: ([127, 0, 0, 1], 9002).into(),
            enabled: false,
        }
    }
}

pub struct BridgeServer {
    config: Arc<RwLock<BridgeConfig>>,
    websocket_handle: Option<JoinHandle<()>>,
    mcp_handle: Option<JoinHandle<()>>,
}

impl BridgeServer {
    pub fn new(config: BridgeConfig) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            websocket_handle: None,
            mcp_handle: None,
        }
    }

    pub async fn start(&mut self) -> Result<()> {
        let config = self.config.read().await;
        if !config.enabled {
            return Ok(());
        }

        tracing::info!("Starting Thunderbolt Bridge server");

        // Start WebSocket server
        let ws_config = self.config.clone();
        self.websocket_handle = Some(tokio::spawn(async move {
            if let Err(e) = websocket::run_server(ws_config).await {
                tracing::error!("WebSocket server error: {}", e);
            }
        }));

        // Start MCP server
        let mcp_config = self.config.clone();
        self.mcp_handle = Some(tokio::spawn(async move {
            if let Err(e) = mcp::run_server(mcp_config).await {
                tracing::error!("MCP server error: {}", e);
            }
        }));

        // Start bridge message handler
        tokio::spawn(async move {
            if let Err(e) = bridge::start_bridge().await {
                tracing::error!("Bridge error: {}", e);
            }
        });

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        tracing::info!("Stopping Thunderbolt Bridge server");

        if let Some(handle) = self.websocket_handle.take() {
            handle.abort();
        }

        if let Some(handle) = self.mcp_handle.take() {
            handle.abort();
        }

        Ok(())
    }

    pub async fn set_enabled(&mut self, enabled: bool) -> Result<()> {
        {
            let mut config = self.config.write().await;
            config.enabled = enabled;
        }

        if enabled {
            self.start().await
        } else {
            self.stop().await
        }
    }

    pub async fn is_enabled(&self) -> bool {
        self.config.read().await.enabled
    }
}
