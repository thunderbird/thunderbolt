use crate::{BridgeConfig, Result};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{sse::Event, Sse, Response, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<MCPError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Clone)]
pub struct MCPServerState {
    bridge_tx: mpsc::UnboundedSender<MCPRequest>,
    sse_tx: tokio::sync::broadcast::Sender<MCPResponse>,
    session_id: Arc<RwLock<Option<String>>>,
}

impl MCPServerState {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<MCPRequest>) {
        let (bridge_tx, bridge_rx) = mpsc::unbounded_channel();
        let (sse_tx, _) = tokio::sync::broadcast::channel(100);
        
        (Self { 
            bridge_tx, 
            sse_tx,
            session_id: Arc::new(RwLock::new(None)),
        }, bridge_rx)
    }
}

async fn handle_mcp_endpoint(
    state: Arc<MCPServerState>,
    headers: HeaderMap,
    method: axum::http::Method,
    body: Option<Json<MCPRequest>>,
) -> Response<axum::body::Body> {
    // Handle GET requests for SSE
    if method == axum::http::Method::GET {
        let mut rx = state.sse_tx.subscribe();
        
        let stream = async_stream::stream! {
            // Send initial connection event
            yield Ok::<_, std::convert::Infallible>(Event::default().event("open").data(""));
            
            while let Ok(response) = rx.recv().await {
                let data = serde_json::to_string(&response).unwrap_or_default();
                yield Ok::<_, std::convert::Infallible>(Event::default().data(data));
            }
        };
        
        return Sse::new(stream).into_response();
    }
    
    // Handle POST requests for JSON-RPC
    if method == axum::http::Method::POST {
        if let Some(Json(request)) = body {
            tracing::debug!("MCP request: {:?}", request);
            
            // Handle different methods
            match request.method.as_str() {
                "initialize" => {
                    // Generate session ID
                    let session_id = Uuid::new_v4().to_string();
                    *state.session_id.write().await = Some(session_id.clone());
                    
                    let response = MCPResponse {
                        jsonrpc: "2.0".to_string(),
                        id: request.id,
                        result: Some(serde_json::json!({
                            "protocolVersion": "0.1.0",
                            "capabilities": {
                                "tools": true,
                                "resources": false,
                                "prompts": false,
                                "logging": false,
                            },
                            "serverInfo": {
                                "name": "Thunderbolt Bridge MCP Server",
                                "version": "1.0.0"
                            }
                        })),
                        error: None,
                    };
                    
                    return Json(response).into_response();
                }
                
                "tools/list" => {
                    let response = MCPResponse {
                        jsonrpc: "2.0".to_string(),
                        id: request.id,
                        result: Some(serde_json::json!({
                            "tools": [
                                {
                                    "name": "thunderbird_contacts",
                                    "description": "Get contacts from Thunderbird",
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {
                                            "query": {
                                                "type": "string",
                                                "description": "Optional search query"
                                            }
                                        }
                                    }
                                },
                                {
                                    "name": "thunderbird_emails",
                                    "description": "Get emails from Thunderbird",
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {
                                            "folder": {
                                                "type": "string",
                                                "description": "Email folder (e.g., INBOX)"
                                            },
                                            "limit": {
                                                "type": "number",
                                                "description": "Maximum number of emails to return"
                                            }
                                        }
                                    }
                                },
                                {
                                    "name": "thunderbird_accounts",
                                    "description": "Get email accounts from Thunderbird",
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {}
                                    }
                                }
                            ]
                        })),
                        error: None,
                    };
                    
                    return Json(response).into_response();
                }
                
                "tools/call" => {
                    // Forward to bridge for processing
                    if let Err(e) = state.bridge_tx.send(request.clone()) {
                        tracing::error!("Failed to forward MCP request: {}", e);
                        let error_response = MCPResponse {
                            jsonrpc: "2.0".to_string(),
                            id: request.id,
                            result: None,
                            error: Some(MCPError {
                                code: -32603,
                                message: "Internal error".to_string(),
                                data: None,
                            }),
                        };
                        return Json(error_response).into_response();
                    }
                    
                    // For now, return acknowledgment that we're processing
                    // The actual response will come through SSE
                    return Response::builder()
                        .status(StatusCode::ACCEPTED)
                        .body(axum::body::Body::empty())
                        .unwrap();
                }
                
                _ => {
                    // Unknown method
                    let response = MCPResponse {
                        jsonrpc: "2.0".to_string(),
                        id: request.id,
                        result: None,
                        error: Some(MCPError {
                            code: -32601,
                            message: format!("Method not found: {}", request.method),
                            data: None,
                        }),
                    };
                    
                    return Json(response).into_response();
                }
            }
        }
    }
    
    // Method not allowed
    Response::builder()
        .status(StatusCode::METHOD_NOT_ALLOWED)
        .body(axum::body::Body::empty())
        .unwrap()
}

// Helper functions to extract method and body
async fn mcp_get_handler(
    State(state): State<Arc<MCPServerState>>,
    headers: HeaderMap,
) -> Response<axum::body::Body> {
    handle_mcp_endpoint(state, headers, axum::http::Method::GET, None).await
}

async fn mcp_post_handler(
    State(state): State<Arc<MCPServerState>>,
    headers: HeaderMap,
    Json(body): Json<MCPRequest>,
) -> Response<axum::body::Body> {
    handle_mcp_endpoint(state, headers, axum::http::Method::POST, Some(Json(body))).await
}

pub async fn run_server(config: Arc<RwLock<BridgeConfig>>) -> Result<()> {
    let addr = config.read().await.mcp_addr;
    
    let (state, bridge_rx) = MCPServerState::new();
    let state = Arc::new(state);
    
    // Store channels for bridge access
    {
        let mut bridge_state = crate::bridge::BRIDGE_STATE.lock().await;
        bridge_state.mcp_request_rx = Some(bridge_rx);
        bridge_state.mcp_response_tx = Some(state.sse_tx.clone());
    }
    
    let app = Router::new()
        // Main MCP endpoint that handles both GET (SSE) and POST (JSON-RPC)
        .route("/mcp/", get(mcp_get_handler).post(mcp_post_handler))
        // Legacy endpoints for backward compatibility
        .route("/", post(mcp_post_handler))
        .route("/sse", get(mcp_get_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);
    
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("MCP server listening on: {}", addr);
    
    axum::serve(listener, app).await?;
    Ok(())
}