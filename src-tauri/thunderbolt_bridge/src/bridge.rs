use crate::{mcp::{MCPRequest, MCPResponse, MCPError}, websocket::{ThunderbirdMessage, WebSocketServer}, Result};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

pub struct BridgeState {
    pub websocket_server: Option<Arc<WebSocketServer>>,
    pub mcp_request_rx: Option<mpsc::UnboundedReceiver<MCPRequest>>,
    pub mcp_response_tx: Option<tokio::sync::broadcast::Sender<MCPResponse>>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            websocket_server: None,
            mcp_request_rx: None,
            mcp_response_tx: None,
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

async fn handle_mcp_request(request: MCPRequest) -> Result<()> {
    tracing::debug!("Handling MCP request: {:?}", request);
    
    // Only forward tools/call requests to Thunderbird
    if request.method != "tools/call" {
        return Ok(());
    }
    
    let state = BRIDGE_STATE.lock().await;
    let ws_server = state.websocket_server.as_ref().ok_or(crate::BridgeError::NotConnected)?;
    let ws_server = ws_server.clone();
    drop(state);
    
    // Get active WebSocket connection
    let conn_id = ws_server.get_active_connection()
        .ok_or(crate::BridgeError::NotConnected)?;
    
    // Extract tool name and arguments from tools/call params
    let tool_name = request.params.as_ref()
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .ok_or(crate::BridgeError::InvalidMessage)?;
    
    let tool_args = request.params.as_ref()
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or(Value::Null);
    
    // Convert MCP request to Thunderbird message
    let tb_message = ThunderbirdMessage::Request {
        id: request.id.to_string(),
        method: tool_name.to_string(),
        params: tool_args,
    };
    
    // Send to Thunderbird
    ws_server.send_to_connection(conn_id, tb_message).await?;
    
    Ok(())
}

async fn handle_websocket_message(conn_id: Uuid, message: ThunderbirdMessage) -> Result<()> {
    tracing::debug!("Handling WebSocket message from {}: {:?}", conn_id, message);
    
    match message {
        ThunderbirdMessage::Response { id, result, error } => {
            let state = BRIDGE_STATE.lock().await;
            if let Some(tx) = &state.mcp_response_tx {
                // Wrap the result in MCP tools/call response format
                let mcp_result = if let Some(result_value) = result {
                    Some(serde_json::json!({
                        "content": [
                            {
                                "type": "text",
                                "text": serde_json::to_string_pretty(&result_value).unwrap_or_default()
                            }
                        ]
                    }))
                } else {
                    None
                };
                
                let mcp_response = MCPResponse {
                    jsonrpc: "2.0".to_string(),
                    id: Value::String(id),
                    result: mcp_result,
                    error: error.map(|e| MCPError {
                        code: -32000,
                        message: e,
                        data: None,
                    }),
                };
                
                if let Err(e) = tx.send(mcp_response) {
                    tracing::error!("Failed to send MCP response: {}", e);
                }
            }
        }
        _ => {
            tracing::warn!("Unexpected message type from WebSocket");
        }
    }
    
    Ok(())
}