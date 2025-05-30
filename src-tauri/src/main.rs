// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db_pool;
mod embedding;
mod libsql;
mod state;

use anyhow::Result;
use thunderbolt_imap_client::{messages_to_json_values, ImapClient, ImapCredentials};
use thunderbolt_imap_sync::ImapSync;
use chrono::{DateTime, Utc};
use serde_json;
use std::env;
use tauri::{command, Manager};
use tokio::sync::Mutex;

use crate::state::AppState;

#[command]
async fn toggle_dock_icon(app_handle: tauri::AppHandle, show: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;

        let policy = if show {
            ActivationPolicy::Regular
        } else {
            ActivationPolicy::Accessory
        };

        let _ = app_handle.set_activation_policy(policy);
    }

    Ok(())
}

#[command]
async fn init_imap(
    app_handle: tauri::AppHandle,
    hostname: String,
    port: u16,
    username: String,
    password: String,
) -> Result<(), String> {
    // Access state directly
    let state = app_handle.state::<Mutex<AppState>>();
    let mut state_guard = state.lock().await;

    // Create ImapCredentials from provided parameters
    let credentials = ImapCredentials {
        hostname,
        port,
        username,
        password,
    };

    // Create IMAP client
    let imap_client = ImapClient::new(credentials);

    // Test connection
    imap_client
        .connect()
        .map_err(|e| format!("Failed to connect to IMAP server: {}", e))?;

    // Store client in state
    state_guard.imap_client = Some(imap_client);

    Ok(())
}

#[command]
async fn init_imap_sync(
    app_handle: tauri::AppHandle,
    hostname: String,
    port: u16,
    username: String,
    password: String,
) -> Result<(), String> {
    // Access state directly
    let state = app_handle.state::<Mutex<AppState>>();
    let mut state_guard = state.lock().await;

    // Check if IMAP client is initialized
    if state_guard.imap_client.is_none() {
        return Err("IMAP client not initialized. Call init_imap first.".to_string());
    }

    // Check if database connection is initialized
    if state_guard.db_pool.is_none() {
        return Err("Database not initialized. Call init_libsql first.".to_string());
    }

    // Create a new IMAP client for the sync service using provided credentials
    let sync_credentials = ImapCredentials {
        hostname,
        port,
        username,
        password,
    };
    let sync_imap_client = ImapClient::new(sync_credentials);

    // Connect the sync client
    sync_imap_client
        .connect()
        .map_err(|e| format!("Failed to connect sync client: {}", e))?;

    // Get database pool
    let pool = state_guard.db_pool.as_ref().unwrap();

    // Create a dedicated connection for the sync service
    let db_conn = pool
        .get_database()
        .connect()
        .map_err(|e| format!("Failed to create connection for sync: {}", e))?;

    // Create the ImapSync instance using the database connection
    let imap_sync = ImapSync::new(sync_imap_client, db_conn);
    state_guard.imap_sync = Some(imap_sync);

    Ok(())
}

#[command]
async fn list_mailboxes(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Access state directly
    let state = app_handle.state::<Mutex<AppState>>();
    let state_guard = state.lock().await;

    // Get IMAP client
    let imap_client = state_guard
        .imap_client
        .as_ref()
        .ok_or_else(|| "IMAP client not initialized. Call init_imap first.".to_string())?;

    // List mailboxes
    let mailboxes = imap_client
        .list_mailboxes()
        .map_err(|e| format!("Failed to list mailboxes: {}", e))?;

    // Convert the HashMap to a JSON value
    serde_json::to_value(&mailboxes).map_err(|e| format!("Failed to serialize mailboxes: {}", e))
}

#[command]
async fn fetch_inbox(
    app_handle: tauri::AppHandle,
    count: Option<usize>,
) -> Result<serde_json::Value, String> {
    // Access state directly
    let state = app_handle.state::<Mutex<AppState>>();
    let state_guard = state.lock().await;

    // Get IMAP client
    let imap_client = state_guard
        .imap_client
        .as_ref()
        .ok_or_else(|| "IMAP client not initialized. Call init_imap first.".to_string())?;

    // Fetch inbox messages
    let messages = imap_client
        .fetch_inbox("INBOX", None, count)
        .map_err(|e| format!("Failed to fetch inbox: {}", e))?;

    // Process all messages using the utility function
    let processed_messages = messages_to_json_values(&messages)
        .map_err(|e| format!("Failed to convert messages to JSON: {}", e))?;

    // Convert the processed messages to a single JSON value
    serde_json::to_value(&processed_messages)
        .map_err(|e| format!("Failed to serialize messages: {}", e))
}

#[command]
async fn fetch_messages(
    app_handle: tauri::AppHandle,
    mailbox: String,
    start_index: Option<usize>,
    count: Option<usize>,
) -> Result<thunderbolt_imap_client::FetchMessagesResponse, String> {
    // Access state directly
    let state = app_handle.state::<Mutex<AppState>>();
    let state_guard = state.lock().await;

    // Get IMAP client
    let imap_client = state_guard
        .imap_client
        .as_ref()
        .ok_or_else(|| "IMAP client not initialized. Call init_imap first.".to_string())?;

    // Fetch messages from specified mailbox
    imap_client
        .fetch_messages(&mailbox, start_index, count)
        .map_err(|e| format!("Failed to fetch messages from {}: {}", mailbox, e))
}

#[command]
async fn sync_mailbox(
    app_handle: tauri::AppHandle,
    mailbox: String,
    page_size: usize,
    since: Option<String>,
) -> Result<usize, String> {
    // Clone the app handle to avoid lifetime issues
    let app_handle = app_handle.clone();

    // Spawn a tokio task to handle the sync
    let result = tokio::spawn(async move {
        let state = app_handle.state::<Mutex<AppState>>();
        let state_guard = state.lock().await;

        // Get sync client
        let sync_client = state_guard
            .imap_sync
            .as_ref()
            .ok_or_else(|| "IMAP sync not initialized. Call init_imap_sync first.".to_string())?;

        // Parse the since date if provided
        let since_date = if let Some(since_str) = since {
            Some(
                DateTime::parse_from_rfc3339(&since_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| format!("Failed to parse date: {}", e))?,
            )
        } else {
            None
        };

        // Sync the mailbox
        sync_client
            .sync_mailbox(&mailbox, page_size, since_date)
            .await
            .map_err(|e| format!("Failed to sync mailbox: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?;

    result
}

#[command]
fn get_env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

#[command]
async fn init_bridge(app_handle: tauri::AppHandle) -> Result<(), String> {
    use std::sync::Arc;
    use thunderbolt_bridge::{BridgeConfig, BridgeServer};
    
    let state = app_handle.state::<Mutex<AppState>>();
    let mut state_guard = state.lock().await;
    
    // Create bridge server with default config
    let config = BridgeConfig::default();
    let bridge_server = BridgeServer::new(config);
    
    state_guard.bridge_server = Some(Arc::new(Mutex::new(bridge_server)));
    
    Ok(())
}

#[command]
async fn set_bridge_enabled(app_handle: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let state_guard = state.lock().await;
    
    if let Some(bridge_server) = &state_guard.bridge_server {
        let mut server = bridge_server.lock().await;
        server.set_enabled(enabled).await
            .map_err(|e| format!("Failed to set bridge state: {}", e))?;
    } else {
        return Err("Bridge not initialized. Call init_bridge first.".to_string());
    }
    
    Ok(())
}

#[command]
async fn get_bridge_status(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let state_guard = state.lock().await;
    
    if let Some(bridge_server) = &state_guard.bridge_server {
        let server = bridge_server.lock().await;
        Ok(server.is_enabled().await)
    } else {
        Ok(false)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // This should be called as early in the execution of the app as possible
    #[cfg(debug_assertions)] // only enable instrumentation in development builds
    let devtools = tauri_plugin_devtools::init();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(Mutex::new(AppState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_dock_icon,
            libsql::init_libsql,
            libsql::execute,
            libsql::select,
            init_imap,
            init_imap_sync,
            fetch_inbox,
            fetch_messages,
            list_mailboxes,
            sync_mailbox,
            embedding::generate_embeddings,
            embedding::init_embedder,
            get_env,
            init_bridge,
            set_bridge_enabled,
            get_bridge_status
        ]);

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(devtools);
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    Ok(())
}
