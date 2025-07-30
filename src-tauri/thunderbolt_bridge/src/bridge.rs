use crate::{
    mcp::BridgeMessage,
    websocket::{ThunderbirdMessage, WebSocketServer},
    Result,
};
use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

pub struct BridgeState {
    pub websocket_server: Option<Arc<WebSocketServer>>,
    pub mcp_request_rx: Option<mpsc::UnboundedReceiver<BridgeMessage>>,
    pub pending_responses:
        Arc<DashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self::new()
    }
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            websocket_server: None,
            mcp_request_rx: None,
            pending_responses: Arc::new(DashMap::new()),
        }
    }
}

lazy_static::lazy_static! {
    pub static ref BRIDGE_STATE: Arc<Mutex<BridgeState>> = Arc::new(Mutex::new(BridgeState::new()));
}

pub async fn start_bridge() -> Result<()> {
    tracing::info!("Starting bridge between MCP and WebSocket");

    // Handle MCP requests
    let mcp_task = tokio::spawn(async move {
        loop {
            let mut state = BRIDGE_STATE.lock().await;
            if let Some(rx) = &mut state.mcp_request_rx {
                if let Ok(request) = rx.try_recv() {
                    drop(state); // Release lock before processing
                    if let Err(e) = handle_mcp_request(request).await {
                        tracing::error!("Error handling MCP request: {}", e);
                    }
                } else {
                    drop(state);
                    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                }
            } else {
                drop(state);
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }
    });

    // Handle WebSocket messages
    let ws_task = tokio::spawn(async move {
        loop {
            let state = BRIDGE_STATE.lock().await;
            if let Some(ws_server) = &state.websocket_server {
                let ws_server = ws_server.clone();
                drop(state); // Release lock before processing

                if let Some((conn_id, message)) = ws_server.recv_message().await {
                    if let Err(e) = handle_websocket_message(conn_id, message).await {
                        tracing::error!("Error handling WebSocket message: {}", e);
                    }
                }
            } else {
                drop(state);
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }
    });

    // Wait for tasks (they run forever)
    let _ = tokio::join!(mcp_task, ws_task);

    Ok(())
}

async fn handle_mcp_request(request: BridgeMessage) -> Result<()> {
    tracing::debug!("Handling MCP bridge request: {:?}", request);

    let state = BRIDGE_STATE.lock().await;
    let ws_server = state.websocket_server.as_ref().ok_or_else(|| {
        tracing::warn!("WebSocket server not initialized in bridge state");
        crate::BridgeError::NotConnected
    })?;
    let ws_server = ws_server.clone();
    drop(state);

    // Get active WebSocket connection
    let conn_id = ws_server.get_active_connection().ok_or_else(|| {
        tracing::warn!("No active WebSocket connection found. Thunderbird may not be connected.");
        crate::BridgeError::NotConnected
    })?;

    // Convert MCP tool name to Thunderbird action - use the original tool name
    let action = request.tool_name.as_str();

    // Convert MCP request to Thunderbird message
    let id_string = match &request.id {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };

    let tb_message = ThunderbirdMessage::Request {
        id: id_string,
        method: action.to_string(),
        params: request.arguments,
    };

    // Send to Thunderbird
    ws_server.send_to_connection(conn_id, tb_message).await?;

    Ok(())
}

async fn handle_websocket_message(conn_id: Uuid, message: ThunderbirdMessage) -> Result<()> {
    tracing::info!(
        "🔄 Handling WebSocket message from {}: {:?}",
        conn_id,
        message
    );

    match message {
        ThunderbirdMessage::Response { id, result, error } => {
            tracing::info!(
                "📨 Received response from Thunderbird: id={}, result={:?}, error={:?}",
                id,
                result,
                error
            );

            // Find and notify the waiting MCP request
            let state = BRIDGE_STATE.lock().await;
            let pending_responses = state.pending_responses.clone();
            let pending_count = pending_responses.len();
            drop(state);

            tracing::info!(
                "🔍 Looking for pending request ID: {} (total pending: {})",
                id,
                pending_count
            );

            if let Some((_, tx)) = pending_responses.remove(&id) {
                tracing::info!("✅ Found pending request, sending response");
                let response = if let Some(error_val) = error {
                    tracing::warn!("❌ Sending error response: {}", error_val);
                    Err(error_val.to_string())
                } else if let Some(result_val) = result {
                    tracing::info!("✅ Sending success response");
                    Ok(result_val)
                } else {
                    tracing::info!("✅ Sending default success response");
                    Ok(serde_json::json!({"status": "success"}))
                };

                match tx.send(response) {
                    Ok(_) => tracing::info!("✅ Response sent successfully"),
                    Err(_) => tracing::warn!("❌ Failed to send response - receiver dropped"),
                }
            } else {
                tracing::warn!(
                    "❌ Received response for unknown request ID: {} (pending IDs: {:?})",
                    id,
                    pending_responses
                        .iter()
                        .map(|r| r.key().clone())
                        .collect::<Vec<_>>()
                );
            }
        }
        ThunderbirdMessage::Test { timestamp, message } => {
            tracing::info!(
                "🧪 Received test message from Thunderbird: {} (timestamp: {})",
                message,
                timestamp
            );
        }
        _ => {
            tracing::warn!("❓ Unexpected message type from WebSocket: {:?}", message);
        }
    }

    Ok(())
}

/// Send a request to Thunderbird and wait for the response
pub async fn send_request_and_wait(
    tool_name: String,
    arguments: Value,
    timeout_ms: u64,
) -> std::result::Result<Value, String> {
    let request_id = Uuid::new_v4().to_string();
    tracing::info!(
        "🚀 Starting request: tool={}, id={}, timeout={}ms",
        tool_name,
        request_id,
        timeout_ms
    );

    // Create a channel for the response
    let (tx, rx) = oneshot::channel();

    // Store the response channel
    {
        let state = BRIDGE_STATE.lock().await;
        state.pending_responses.insert(request_id.clone(), tx);
        tracing::info!(
            "📋 Stored pending request: {} (total pending: {})",
            request_id,
            state.pending_responses.len()
        );
    }

    // Create the bridge message
    let bridge_msg = BridgeMessage {
        id: Value::String(request_id.clone()),
        tool_name,
        arguments,
    };

    // Send the request
    if let Err(e) = handle_mcp_request(bridge_msg).await {
        // Remove from pending if sending failed
        let state = BRIDGE_STATE.lock().await;
        state.pending_responses.remove(&request_id);

        // Provide more helpful error messages
        let error_msg = if e.to_string().contains("NotConnected") {
            "Thunderbird is not connected. Please ensure the Thunderbird extension is installed and connected.".to_string()
        } else {
            format!("Failed to send request: {e}")
        };
        return Err(error_msg);
    }

    // Wait for response with timeout
    tracing::info!("⏳ Waiting for response to: {}", request_id);
    match tokio::time::timeout(tokio::time::Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(response)) => {
            tracing::info!("✅ Received response for: {}", request_id);
            response
        }
        Ok(Err(_)) => {
            tracing::warn!("❌ Response channel closed for: {}", request_id);
            Err("Response channel closed".to_string())
        }
        Err(_) => {
            // Remove from pending on timeout
            let state = BRIDGE_STATE.lock().await;
            state.pending_responses.remove(&request_id);
            tracing::error!("⏰ Request timeout for: {} ({}ms)", request_id, timeout_ms);
            Err("Request timeout. Thunderbird may not be responding or connected.".to_string())
        }
    }
}
