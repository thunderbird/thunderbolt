use anyhow::Result;
use thunderbolt_imap_client::{messages_to_json_values, ImapClient, ImapCredentials};
use thunderbolt_imap_sync::ImapSync;
use chrono::{DateTime, Utc};
use serde_json;
use tauri::{command, Manager};
use tokio::sync::Mutex;
use thunderbolt_libsql::LibsqlState;

/// Application state for the email functionality
#[derive(Default)]
pub struct EmailState {
    pub imap_client: Option<ImapClient>,
    pub imap_sync: Option<ImapSync>,
}

// Start commands submodule to isolate tauri command macros
pub mod commands {
    use super::*;

    #[command]
    pub async fn init_imap(
        app_handle: tauri::AppHandle,
        hostname: String,
        port: u16,
        username: String,
        password: String,
    ) -> Result<(), String> {
        // Access state directly
        let state = app_handle.state::<Mutex<EmailState>>();
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
            .map_err(|e| format!("Failed to connect to IMAP server: {e}"))?;

        // Store client in state
        state_guard.imap_client = Some(imap_client);

        Ok(())
    }

    #[command]
    pub async fn init_imap_sync(
        app_handle: tauri::AppHandle,
        hostname: String,
        port: u16,
        username: String,
        password: String,
    ) -> Result<(), String> {
        // Access email state directly
        let email_state = app_handle.state::<Mutex<EmailState>>();
        let mut email_state_guard = email_state.lock().await;

        // Check if IMAP client is initialized
        if email_state_guard.imap_client.is_none() {
            return Err("IMAP client not initialized. Call init_imap first.".to_string());
        }

        // Check if database connection is initialized
        let libsql_state = app_handle.state::<Mutex<LibsqlState>>();
        let libsql_state_guard = libsql_state.lock().await;
        
        if libsql_state_guard.db_pool.is_none() {
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
            .map_err(|e| format!("Failed to connect sync client: {e}"))?;

        // Get database pool
        let pool = libsql_state_guard.db_pool.as_ref().unwrap();

        // Create a dedicated connection for the sync service
        let db_conn = pool
            .get_database()
            .connect()
            .map_err(|e| format!("Failed to create connection for sync: {e}"))?;

        // Create the ImapSync instance using the database connection
        let imap_sync = ImapSync::new(sync_imap_client, db_conn);
        email_state_guard.imap_sync = Some(imap_sync);

        Ok(())
    }

    #[command]
    pub async fn list_mailboxes(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
        // Access state directly
        let state = app_handle.state::<Mutex<EmailState>>();
        let state_guard = state.lock().await;

        // Get IMAP client
        let imap_client = state_guard
            .imap_client
            .as_ref()
            .ok_or_else(|| "IMAP client not initialized. Call init_imap first.".to_string())?;

        // List mailboxes
        let mailboxes = imap_client
            .list_mailboxes()
            .map_err(|e| format!("Failed to list mailboxes: {e}"))?;

        // Convert the HashMap to a JSON value
        serde_json::to_value(&mailboxes).map_err(|e| format!("Failed to serialize mailboxes: {e}"))
    }

    #[command]
    pub async fn fetch_inbox(
        app_handle: tauri::AppHandle,
        count: Option<usize>,
    ) -> Result<serde_json::Value, String> {
        // Access state directly
        let state = app_handle.state::<Mutex<EmailState>>();
        let state_guard = state.lock().await;

        // Get IMAP client
        let imap_client = state_guard
            .imap_client
            .as_ref()
            .ok_or_else(|| "IMAP client not initialized. Call init_imap first.".to_string())?;

        // Fetch inbox messages
        let messages = imap_client
            .fetch_inbox("INBOX", None, count)
            .map_err(|e| format!("Failed to fetch inbox: {e}"))?;

        // Process all messages using the utility function
        let processed_messages = messages_to_json_values(&messages)
            .map_err(|e| format!("Failed to convert messages to JSON: {e}"))?;

        // Convert the processed messages to a single JSON value
        serde_json::to_value(&processed_messages)
            .map_err(|e| format!("Failed to serialize messages: {e}"))
    }

    #[command]
    pub async fn fetch_messages(
        app_handle: tauri::AppHandle,
        mailbox: String,
        start_index: Option<usize>,
        count: Option<usize>,
    ) -> Result<thunderbolt_imap_client::FetchMessagesResponse, String> {
        // Access state directly
        let state = app_handle.state::<Mutex<EmailState>>();
        let state_guard = state.lock().await;

        // Get IMAP client
        let imap_client = state_guard
            .imap_client
            .as_ref()
            .ok_or_else(|| "IMAP client not initialized. Call init_imap first.".to_string())?;

        // Fetch messages from specified mailbox
        imap_client
            .fetch_messages(&mailbox, start_index, count)
            .map_err(|e| format!("Failed to fetch messages from {mailbox}: {e}"))
    }

    #[command]
    pub async fn sync_mailbox(
        app_handle: tauri::AppHandle,
        mailbox: String,
        page_size: usize,
        since: Option<String>,
    ) -> Result<usize, String> {
        // Clone the app handle to avoid lifetime issues
        let app_handle = app_handle.clone();

        // Spawn a tokio task to handle the sync
        let result = tokio::spawn(async move {
            let state = app_handle.state::<Mutex<EmailState>>();
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
                        .map_err(|e| format!("Failed to parse date: {e}"))?,
                )
            } else {
                None
            };

            // Sync the mailbox
            sync_client
                .sync_mailbox(&mailbox, page_size, since_date)
                .await
                .map_err(|e| format!("Failed to sync mailbox: {e}"))
        })
        .await
        .map_err(|e| format!("Task error: {e}"))?;

        result
    }
}

// Re-export commands for main app
pub use commands::{init_imap, init_imap_sync, list_mailboxes, fetch_inbox, fetch_messages, sync_mailbox}; 