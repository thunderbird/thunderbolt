// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod libsql;
mod state;

use anyhow::Result;
use assist_embeddings;
use assist_imap_client::{messages_to_json_values, ImapClient, ImapCredentials};
use assist_imap_sync::ImapSync;
use chrono::{DateTime, Utc};
use mozilla_assist_lib::settings::get_settings;
use serde_json;
use std::env;
use tauri::{command, ActivationPolicy, Manager};
use tokio::sync::Mutex;

use crate::state::AppState;

#[command]
async fn toggle_dock_icon(app_handle: tauri::AppHandle, show: bool) -> Result<(), String> {
    if cfg!(target_os = "macos") {
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
async fn init_imap(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let mut state = state.lock().await;

    // Get database connection
    let conn = state
        .libsql
        .as_mut()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Get settings
    let settings = get_settings(conn)
        .await
        .map_err(|e| format!("Failed to get settings: {}", e))?;

    // Check if account settings exist
    let account_settings = settings
        .account
        .ok_or_else(|| "Account settings not found".to_string())?;

    // Create ImapCredentials from account settings
    let credentials = ImapCredentials {
        hostname: account_settings.hostname.clone(),
        port: account_settings.port,
        username: account_settings.username.clone(),
        password: account_settings.password.clone(),
    };

    // Create IMAP client
    let imap_client = ImapClient::new(credentials);

    // Test connection
    imap_client
        .connect()
        .map_err(|e| format!("Failed to connect to IMAP server: {}", e))?;

    // Store client in state
    state.imap_client = Some(imap_client);

    Ok(())
}

#[command]
async fn init_imap_sync(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let mut state = state.lock().await;

    // Check if IMAP client is initialized
    if state.imap_client.is_none() {
        return Err("IMAP client not initialized. Call init_imap first.".to_string());
    }

    // Check if database connection is initialized
    if state.libsql.is_none() {
        return Err("Database not initialized. Call init_libsql first.".to_string());
    }

    // Get settings to create a new IMAP client for the sync service
    let conn = state.libsql.as_mut().unwrap();

    // Get settings
    let settings = get_settings(conn)
        .await
        .map_err(|e| format!("Failed to get settings: {}", e))?;

    // Check if account settings exist
    let account_settings = settings
        .account
        .ok_or_else(|| "Account settings not found".to_string())?;

    // Create a new IMAP client for the sync service
    let sync_credentials = ImapCredentials {
        hostname: account_settings.hostname,
        port: account_settings.port,
        username: account_settings.username,
        password: account_settings.password,
    };
    let sync_imap_client = ImapClient::new(sync_credentials);

    // Connect the sync client
    sync_imap_client
        .connect()
        .map_err(|e| format!("Failed to connect sync client: {}", e))?;

    // Get a clone of the database connection for the sync service
    let db_conn = state.libsql.as_ref().unwrap().clone();

    // Create the ImapSync instance using the existing database connection
    let imap_sync = ImapSync::new(sync_imap_client, db_conn);
    state.imap_sync = Some(imap_sync);

    Ok(())
}

#[command]
async fn list_mailboxes(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let state = state.lock().await;

    // Get IMAP client
    let imap_client = state
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
    let state = app_handle.state::<Mutex<AppState>>();
    let state = state.lock().await;

    // Get IMAP client
    let imap_client = state
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
            .ok_or_else(|| "IMAP sync not initialized. Call init_imap first.".to_string())?;

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
async fn generate_embeddings(
    app_handle: tauri::AppHandle,
    batch_size: usize,
) -> Result<usize, String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let state = state.lock().await;

    // Get database connection
    let conn = state
        .libsql
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Generate embeddings for all messages
    assist_embeddings::generate_all(conn, batch_size)
        .await
        .map_err(|e| format!("Failed to generate embeddings: {}", e))
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
            list_mailboxes,
            sync_mailbox,
            generate_embeddings
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
