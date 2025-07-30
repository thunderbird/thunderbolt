use futures_util::{SinkExt, StreamExt};
use reqwest;
use serde_json::json;
use std::time::Duration;
use thunderbolt_bridge::{BridgeConfig, BridgeServer};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn test_end_to_end_flow() {
    let _ = tracing_subscriber::fmt::try_init();

    // Create bridge server with test config
    let mut config = BridgeConfig::default();
    config.enabled = true;
    config.websocket_addr = ([127, 0, 0, 1], 9301).into();
    config.mcp_addr = ([127, 0, 0, 1], 9302).into();

    let mut server = BridgeServer::new(config);

    // Start the server
    server.start().await.expect("Failed to start server");

    // Give servers time to start
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Step 1: Connect a mock Thunderbird client to WebSocket
    let ws_url = "ws://127.0.0.1:9301";
    let (ws_stream, _) = connect_async(ws_url)
        .await
        .expect("Failed to connect to WebSocket");

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Step 2: Send MCP request
    let mcp_client = reqwest::Client::new();
    let mcp_request = json!({
        "jsonrpc": "2.0",
        "id": "e2e-test-1",
        "method": "thunderbird_contacts",
        "params": {
            "query": "test"
        }
    });

    // Spawn task to handle WebSocket messages
    let ws_handle = tokio::spawn(async move {
        if let Some(Ok(Message::Text(text))) = ws_read.next().await {
            println!("WebSocket received: {}", text);

            // Parse the request
            let request: serde_json::Value =
                serde_json::from_str(&text).expect("Failed to parse WebSocket message");

            // Send mock response
            let response = json!({
                "type": "response",
                "id": request["id"],
                "result": [{
                    "id": "contact-1",
                    "name": "Test Contact",
                    "email": "test@example.com",
                    "addressBook": "Personal"
                }],
                "error": null
            });

            ws_write
                .send(Message::Text(response.to_string()))
                .await
                .expect("Failed to send WebSocket response");
        }
    });

    // Send MCP request
    let mcp_response = mcp_client
        .post("http://127.0.0.1:9302/")
        .json(&mcp_request)
        .send()
        .await
        .expect("Failed to send MCP request");

    assert_eq!(mcp_response.status(), 200);

    let mcp_body: serde_json::Value = mcp_response
        .json()
        .await
        .expect("Failed to parse MCP response");

    println!(
        "MCP response: {}",
        serde_json::to_string_pretty(&mcp_body).unwrap()
    );

    // Verify MCP response
    assert_eq!(mcp_body["jsonrpc"], "2.0");
    assert_eq!(mcp_body["id"], "e2e-test-1");

    // Wait for WebSocket handler to complete
    tokio::time::timeout(Duration::from_secs(5), ws_handle)
        .await
        .expect("WebSocket handler timeout")
        .expect("WebSocket handler failed");

    // Stop the server
    server.stop().await.expect("Failed to stop server");
}

#[tokio::test]
async fn test_mcp_sse_streaming() {
    let _ = tracing_subscriber::fmt::try_init();

    let mut config = BridgeConfig::default();
    config.enabled = true;
    config.websocket_addr = ([127, 0, 0, 1], 9303).into();
    config.mcp_addr = ([127, 0, 0, 1], 9304).into();

    let mut server = BridgeServer::new(config);
    server.start().await.expect("Failed to start server");
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Connect to SSE endpoint and verify it accepts connections
    let client = reqwest::Client::new();
    let response = client
        .get("http://127.0.0.1:9304/sse")
        .header("Accept", "text/event-stream")
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .expect("Failed to connect to SSE");

    // Verify SSE headers
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/event-stream"
    );

    // For a full test, we would need to parse the SSE stream
    // But for now, just verify the endpoint is accessible
    println!("SSE endpoint is accessible and returns correct headers");

    server.stop().await.expect("Failed to stop server");
}
