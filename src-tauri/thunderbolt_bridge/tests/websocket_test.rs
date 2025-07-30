use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::time::Duration;
use thunderbolt_bridge::{BridgeConfig, BridgeServer};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn test_websocket_connection() {
    // Initialize tracing for tests
    let _ = tracing_subscriber::fmt::try_init();

    // Create bridge server with test config
    let mut config = BridgeConfig::default();
    config.enabled = true;
    config.websocket_addr = ([127, 0, 0, 1], 9101).into(); // Use different port for tests

    let mut server = BridgeServer::new(config);

    // Start the server
    server.start().await.expect("Failed to start server");

    // Give server time to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Connect to WebSocket server
    let url = "ws://127.0.0.1:9101";
    let (ws_stream, _) = connect_async(url).await.expect("Failed to connect");

    let (mut write, mut read) = ws_stream.split();

    // Send a test message
    let test_message = json!({
        "type": "request",
        "id": "test-1",
        "method": "ping",
        "params": {}
    });

    write
        .send(Message::Text(test_message.to_string()))
        .await
        .expect("Failed to send message");

    // Read response (if any)
    let timeout = tokio::time::timeout(Duration::from_secs(2), read.next()).await;

    match timeout {
        Ok(Some(Ok(msg))) => {
            println!("Received message: {:?}", msg);
        }
        Ok(Some(Err(e))) => {
            panic!("Error receiving message: {}", e);
        }
        Ok(None) => {
            println!("Connection closed");
        }
        Err(_) => {
            println!("No response received (timeout)");
        }
    }

    // Stop the server
    server.stop().await.expect("Failed to stop server");
}

#[tokio::test]
async fn test_websocket_reconnection() {
    let _ = tracing_subscriber::fmt::try_init();

    let mut config = BridgeConfig::default();
    config.enabled = true;
    config.websocket_addr = ([127, 0, 0, 1], 9102).into();

    let mut server = BridgeServer::new(config);

    // Start server
    server.start().await.expect("Failed to start server");
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Connect first client
    let url = "ws://127.0.0.1:9102";
    let (ws_stream1, _) = connect_async(url).await.expect("Failed to connect");

    // Close first connection
    drop(ws_stream1);

    // Connect second client (should succeed)
    let (ws_stream2, _) = connect_async(url).await.expect("Failed to reconnect");

    // Verify second connection works
    let (mut write, _read) = ws_stream2.split();
    let test_message = json!({
        "type": "request",
        "id": "test-2",
        "method": "ping",
        "params": {}
    });

    write
        .send(Message::Text(test_message.to_string()))
        .await
        .expect("Failed to send message on reconnected stream");

    server.stop().await.expect("Failed to stop server");
}
