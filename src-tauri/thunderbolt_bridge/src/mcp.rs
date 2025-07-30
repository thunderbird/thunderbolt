use crate::{BridgeConfig, Result as BridgeResult};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info};

#[derive(Debug, Clone)]
pub struct BridgeMessage {
    pub id: Value,
    pub tool_name: String,
    pub arguments: Value,
}

#[derive(Clone)]
struct ThunderboltTools {}

impl ThunderboltTools {
    fn new() -> Self {
        Self {}
    }
}

impl ThunderboltTools {
    /// Get contacts from Thunderbird
    async fn thunderbird_contacts(&self, query: Option<String>) -> Result<Value, String> {
        // Use the new bridge function to send request and wait for response
        match crate::bridge::send_request_and_wait(
            "thunderbird_contacts".to_string(),
            json!({ "query": query }),
            5000, // 5 second timeout
        )
        .await
        {
            Ok(result) => Ok(result),
            Err(e) => Err(format!("Thunderbird error: {e}")),
        }
    }

    /// Get emails from Thunderbird
    async fn thunderbird_emails(
        &self,
        folder: Option<String>,
        limit: Option<u32>,
    ) -> Result<Value, String> {
        // Use the new bridge function to send request and wait for response
        match crate::bridge::send_request_and_wait(
            "thunderbird_emails".to_string(),
            json!({ "folder": folder, "limit": limit }),
            5000, // 5 second timeout
        )
        .await
        {
            Ok(result) => Ok(result),
            Err(e) => Err(format!("Thunderbird error: {e}")),
        }
    }

    /// Get email accounts from Thunderbird
    async fn thunderbird_accounts(&self) -> Result<Value, String> {
        // Use the new bridge function to send request and wait for response
        match crate::bridge::send_request_and_wait(
            "thunderbird_accounts".to_string(),
            json!({}),
            5000, // 5 second timeout
        )
        .await
        {
            Ok(result) => Ok(result),
            Err(e) => Err(format!("Thunderbird error: {e}")),
        }
    }
}

/// HTTP service handler that processes MCP requests using rmcp
async fn handle_http_request(
    tools: Arc<ThunderboltTools>,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    // Check if this is the /mcp endpoint
    if req.uri().path() != "/mcp" {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Access-Control-Allow-Origin", "*")
            .body(Full::new(Bytes::from("Not Found")))
            .unwrap());
    }

    // Handle OPTIONS preflight requests
    if req.method() == hyper::Method::OPTIONS {
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "POST, OPTIONS")
            .header(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization",
            )
            .header("Access-Control-Max-Age", "86400")
            .body(Full::new(Bytes::from("")))
            .unwrap());
    }

    // Only accept POST requests
    if req.method() != hyper::Method::POST {
        return Ok(Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("Access-Control-Allow-Origin", "*")
            .body(Full::new(Bytes::from("Method Not Allowed")))
            .unwrap());
    }

    // Read the request body
    let body_bytes = match req.collect().await {
        Ok(body) => body.to_bytes(),
        Err(e) => {
            error!("Failed to read request body: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header("Access-Control-Allow-Origin", "*")
                .body(Full::new(Bytes::from("Bad Request")))
                .unwrap());
        }
    };

    // Parse as JSON-RPC request
    let json_request: serde_json::Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(e) => {
            error!("Failed to parse JSON request: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header("Access-Control-Allow-Origin", "*")
                .body(Full::new(Bytes::from("Invalid JSON")))
                .unwrap());
        }
    };

    debug!("Received MCP request: {:?}", json_request);

    // Handle JSON-RPC requests manually
    let method = json_request
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let params = json_request.get("params").cloned().unwrap_or(json!({}));
    let id = json_request.get("id").cloned();

    let result = match method {
        "initialize" => {
            // Handle MCP initialization
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {
                        "listChanged": true
                    }
                },
                "serverInfo": {
                    "name": "Thunderbolt MCP Server",
                    "version": "0.1.0"
                }
            })
        }
        "notifications/initialized" => {
            // Client has initialized - just acknowledge
            json!({})
        }
        "tools/list" => {
            // List available tools
            json!({
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
                            },
                            "required": []
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
                                    "description": "Optional folder name"
                                },
                                "limit": {
                                    "type": "integer",
                                    "description": "Maximum number of emails to return"
                                }
                            },
                            "required": []
                        }
                    },
                    {
                        "name": "thunderbird_accounts",
                        "description": "Get email accounts from Thunderbird",
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "required": []
                        }
                    }
                ]
            })
        }
        "tools/call" => {
            // Handle tool calls
            let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let tool_args = params.get("arguments").cloned().unwrap_or(json!({}));

            match tool_name {
                "thunderbird_contacts" => {
                    let query = tool_args
                        .get("query")
                        .and_then(|q| q.as_str())
                        .map(String::from);
                    match tools.thunderbird_contacts(query).await {
                        Ok(result) => result,
                        Err(e) => json!({
                            "error": true,
                            "message": e,
                            "details": "Failed to retrieve contacts from Thunderbird"
                        }),
                    }
                }
                "thunderbird_emails" => {
                    let folder = tool_args
                        .get("folder")
                        .and_then(|f| f.as_str())
                        .map(String::from);
                    let limit = tool_args
                        .get("limit")
                        .and_then(|l| l.as_u64())
                        .map(|l| l as u32);
                    match tools.thunderbird_emails(folder, limit).await {
                        Ok(result) => result,
                        Err(e) => json!({
                            "error": true,
                            "message": e,
                            "details": "Failed to retrieve emails from Thunderbird"
                        }),
                    }
                }
                "thunderbird_accounts" => match tools.thunderbird_accounts().await {
                    Ok(result) => result,
                    Err(e) => json!({
                        "error": true,
                        "message": e,
                        "details": "Failed to retrieve accounts from Thunderbird"
                    }),
                },
                _ => json!({
                    "error": true,
                    "message": format!("Unknown tool: {}", tool_name),
                    "details": "Tool not found"
                }),
            }
        }
        _ => json!({
            "error": true,
            "message": format!("Method not found: {}", method),
            "details": "MCP method not supported"
        }),
    };

    // For notifications, don't send a response
    let response = if method.starts_with("notifications/") {
        // Notifications don't get responses
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/json")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "POST, OPTIONS")
            .header(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization",
            )
            .body(Full::new(Bytes::from("{}")))
            .unwrap());
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        })
    };

    // Serialize response
    let response_bytes = serde_json::to_vec(&response).unwrap_or_else(|_| {
        br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Failed to serialize response"}}"#.to_vec()
    });

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "POST, OPTIONS")
        .header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        )
        .body(Full::new(Bytes::from(response_bytes)))
        .unwrap())
}

pub async fn run_server(config: Arc<RwLock<BridgeConfig>>) -> BridgeResult<()> {
    let addr = config.read().await.mcp_addr;

    // Create channel for bridge communication
    let (_bridge_tx, bridge_rx) = mpsc::unbounded_channel::<BridgeMessage>();

    // Store channel for bridge access
    {
        let mut bridge_state = crate::bridge::BRIDGE_STATE.lock().await;
        bridge_state.mcp_request_rx = Some(bridge_rx);
    }

    // Create the tools instance
    let tools = Arc::new(ThunderboltTools::new());

    // Bind to the address
    let listener = TcpListener::bind(addr).await?;
    info!("MCP server listening on: http://{}/mcp", addr);

    // Accept connections and serve them
    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let tools = Arc::clone(&tools);

        tokio::task::spawn(async move {
            if let Err(err) = http1::Builder::new()
                .serve_connection(
                    io,
                    service_fn(|req| {
                        let tools = Arc::clone(&tools);
                        async move { handle_http_request(tools, req).await }
                    }),
                )
                .await
            {
                error!("Error serving connection: {:?}", err);
            }
        });
    }
}
