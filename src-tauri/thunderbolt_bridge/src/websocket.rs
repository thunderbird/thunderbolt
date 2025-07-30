use crate::{BridgeConfig, Result};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ThunderbirdMessage {
    #[serde(rename = "request")]
    Request {
        id: String,
        method: String,
        params: serde_json::Value,
    },
    #[serde(rename = "response")]
    Response {
        id: String,
        result: Option<serde_json::Value>,
        error: Option<String>,
    },
    #[serde(rename = "test")]
    Test { timestamp: u64, message: String },
}

pub struct WebSocketConnection {
    _id: Uuid,
    tx: mpsc::UnboundedSender<Message>,
}

pub struct WebSocketServer {
    connections: Arc<DashMap<Uuid, WebSocketConnection>>,
    message_tx: mpsc::UnboundedSender<(Uuid, ThunderbirdMessage)>,
    message_rx: Arc<RwLock<mpsc::UnboundedReceiver<(Uuid, ThunderbirdMessage)>>>,
}

impl Default for WebSocketServer {
    fn default() -> Self {
        Self::new()
    }
}

impl WebSocketServer {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            connections: Arc::new(DashMap::new()),
            message_tx: tx,
            message_rx: Arc::new(RwLock::new(rx)),
        }
    }

    pub async fn handle_connection(
        &self,
        stream: TcpStream,
        addr: std::net::SocketAddr,
    ) -> Result<()> {
        tracing::info!("🔌 New WebSocket connection from: {}", addr);

        let ws_stream = accept_async(stream).await?;
        let conn_id = Uuid::new_v4();
        tracing::info!(
            "✅ WebSocket handshake completed for connection: {}",
            conn_id
        );

        let (tx, rx) = mpsc::unbounded_channel();
        let connection = WebSocketConnection { _id: conn_id, tx };

        self.connections.insert(conn_id, connection);

        self.handle_messages(conn_id, ws_stream, rx).await?;

        self.connections.remove(&conn_id);
        tracing::info!("❌ WebSocket connection {} closed", conn_id);

        Ok(())
    }

    async fn handle_messages(
        &self,
        conn_id: Uuid,
        ws_stream: WebSocketStream<TcpStream>,
        mut rx: mpsc::UnboundedReceiver<Message>,
    ) -> Result<()> {
        let (mut ws_sender, mut ws_receiver) = ws_stream.split();
        let message_tx = self.message_tx.clone();

        // Spawn task to send messages to client
        let send_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Err(e) = ws_sender.send(msg).await {
                    tracing::error!("Error sending WebSocket message: {}", e);
                    break;
                }
            }
        });

        // Handle incoming messages
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    tracing::debug!("📨 Received WebSocket message from {}: {}", conn_id, text);
                    match serde_json::from_str::<ThunderbirdMessage>(&text) {
                        Ok(tb_msg) => {
                            tracing::info!("✅ Parsed Thunderbird message: {:?}", tb_msg);
                            if let Err(e) = message_tx.send((conn_id, tb_msg)) {
                                tracing::error!("Error forwarding message: {}", e);
                            }
                        }
                        Err(e) => {
                            tracing::error!("❌ Error parsing message: {} - Raw text: {}", e, text);
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    tracing::error!("WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        send_task.abort();
        Ok(())
    }

    pub async fn send_to_connection(&self, conn_id: Uuid, msg: ThunderbirdMessage) -> Result<()> {
        if let Some(conn) = self.connections.get(&conn_id) {
            let text = serde_json::to_string(&msg)?;
            tracing::info!("📤 Sending message to connection {}: {}", conn_id, text);
            conn.tx
                .send(Message::Text(text))
                .map_err(|_| crate::BridgeError::NotConnected)?;
            Ok(())
        } else {
            tracing::error!("❌ Connection {} not found", conn_id);
            Err(crate::BridgeError::NotConnected)
        }
    }

    pub async fn broadcast(&self, msg: ThunderbirdMessage) -> Result<()> {
        let text = serde_json::to_string(&msg)?;
        for conn in self.connections.iter() {
            let _ = conn.tx.send(Message::Text(text.clone()));
        }
        Ok(())
    }

    pub fn get_active_connection(&self) -> Option<Uuid> {
        let result = self.connections.iter().next().map(|entry| *entry.key());
        tracing::debug!(
            "🔍 Active connections: {} total, active: {:?}",
            self.connections.len(),
            result
        );
        result
    }

    pub async fn recv_message(&self) -> Option<(Uuid, ThunderbirdMessage)> {
        self.message_rx.write().await.recv().await
    }
}

pub async fn run_server(config: Arc<RwLock<BridgeConfig>>) -> Result<()> {
    let addr = config.read().await.websocket_addr;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!("WebSocket server listening on: {}", addr);

    let server = Arc::new(WebSocketServer::new());

    // Store server instance for bridge access
    {
        let mut bridge_state = crate::bridge::BRIDGE_STATE.lock().await;
        bridge_state.websocket_server = Some(server.clone());
    }

    loop {
        let (stream, addr) = listener.accept().await?;
        let server = server.clone();

        tokio::spawn(async move {
            if let Err(e) = server.handle_connection(stream, addr).await {
                tracing::error!("Error handling connection: {}", e);
            }
        });
    }
}
