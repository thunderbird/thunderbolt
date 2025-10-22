use anyhow::Result;
use serde::Serialize;
use tauri::command;
use tauri::Manager;

#[cfg(feature = "bridge")]
use crate::state::AppState;
#[cfg(feature = "bridge")]
use serde_json;
#[cfg(feature = "bridge")]
use tokio::sync::Mutex;

#[command]
pub async fn toggle_dock_icon(app_handle: tauri::AppHandle, show: bool) -> Result<(), String> {
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

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        let _ = show;
    }

    Ok(())
}

#[command]
pub fn get_env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

#[cfg(feature = "bridge")]
#[command]
pub async fn init_bridge(app_handle: tauri::AppHandle) -> Result<(), String> {
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

#[cfg(feature = "bridge")]
#[command]
pub async fn set_bridge_enabled(app_handle: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let state_guard = state.lock().await;

    if let Some(bridge_server) = &state_guard.bridge_server {
        let mut server = bridge_server.lock().await;
        server
            .set_enabled(enabled)
            .await
            .map_err(|e| format!("Failed to set bridge state: {e}"))?;
    } else {
        return Err("Bridge not initialized. Call init_bridge first.".to_string());
    }

    Ok(())
}

#[cfg(feature = "bridge")]
#[command]
pub async fn get_bridge_status(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let state = app_handle.state::<Mutex<AppState>>();
    let state_guard = state.lock().await;

    if let Some(bridge_server) = &state_guard.bridge_server {
        let server = bridge_server.lock().await;
        Ok(server.is_enabled().await)
    } else {
        Ok(false)
    }
}

#[cfg(feature = "bridge")]
#[command]
pub async fn get_bridge_connection_status() -> Result<serde_json::Value, String> {
    use thunderbolt_bridge::bridge::BRIDGE_STATE;

    let state = BRIDGE_STATE.lock().await;
    let has_websocket_server = state.websocket_server.is_some();
    let has_mcp_rx = state.mcp_request_rx.is_some();

    let active_connections = if let Some(ws_server) = &state.websocket_server {
        ws_server.get_active_connection().is_some()
    } else {
        false
    };

    Ok(serde_json::json!({
        "websocket_server_initialized": has_websocket_server,
        "mcp_receiver_initialized": has_mcp_rx,
        "thunderbird_connected": active_connections,
        "bridge_ready": has_websocket_server && has_mcp_rx && active_connections
    }))
}

// === Capabilities ============================================================================

/// List of runtime capabilities that the renderer can query once and cache.
/// Extend this struct whenever we add more feature flags.
#[derive(Serialize)]
pub struct Capabilities {
    /// Whether the application was compiled with the `libsql` feature and the corresponding
    /// commands (`init_libsql`, `execute`, `select`) are available.
    pub libsql: bool,
    /// Whether the application was compiled with the `native_fetch` feature and therefore the
    /// `tauri-plugin-http` plugin is available for native HTTP requests.
    pub native_fetch: bool,
}

// Compile-time flag so we do not need to look anything up at runtime.
#[cfg(feature = "libsql")]
const LIBSQL_ENABLED: bool = true;
#[cfg(not(feature = "libsql"))]
const LIBSQL_ENABLED: bool = false;

#[cfg(feature = "native_fetch")]
const NATIVE_FETCH_ENABLED: bool = true;
#[cfg(not(feature = "native_fetch"))]
const NATIVE_FETCH_ENABLED: bool = false;

/// Returns the set of capabilities supported by the current build.
#[command]
pub fn capabilities() -> Capabilities {
    Capabilities {
        libsql: LIBSQL_ENABLED,
        native_fetch: NATIVE_FETCH_ENABLED,
    }
}

/// Creates a webview with non-persistent storage to prevent keychain access prompts.
/// This uses a combination of incognito mode and data store identifier to ensure
/// WebCrypto operations don't trigger keychain access on macOS.
#[command]
pub async fn create_sidebar_webview(
    app_handle: tauri::AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    // Generate a unique data store identifier for this webview
    // Using a random identifier ensures each webview has its own ephemeral storage
    let data_store_id: [u8; 16] = {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hash, Hasher};

        let hasher_builder = RandomState::new();
        let mut hasher = hasher_builder.build_hasher();
        label.hash(&mut hasher);
        std::time::SystemTime::now().hash(&mut hasher);
        let hash = hasher.finish();

        // Convert hash to 16-byte array
        let mut id = [0u8; 16];
        id[0..8].copy_from_slice(&hash.to_le_bytes());
        id[8..16].copy_from_slice(&hash.to_be_bytes());
        id
    };

    // JavaScript to disable WebCrypto API to prevent keychain access
    // This is injected before any page scripts run
    let disable_webcrypto_script = r#"
        (function() {
            if (window.crypto && window.crypto.subtle) {
                // Replace crypto.subtle with a non-functional stub
                Object.defineProperty(window.crypto, 'subtle', {
                    get: function() {
                        console.warn('WebCrypto API has been disabled in this webview to prevent keychain access prompts');
                        return undefined;
                    },
                    configurable: false
                });
            }
        })();
    "#;

    WebviewWindowBuilder::new(
        &app_handle,
        &label,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {e}"))?),
    )
    .position(x, y)
    .inner_size(width, height)
    .incognito(true)
    .data_store_identifier(data_store_id)
    .initialization_script(disable_webcrypto_script)
    .visible(true)
    .decorations(false)
    .build()
    .map_err(|e| format!("Failed to create webview: {e}"))?;

    Ok(())
}

/// Closes a webview by label.
#[command]
pub async fn close_sidebar_webview(
    app_handle: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    use tauri::Manager;

    if let Some(webview) = app_handle.get_webview_window(&label) {
        webview
            .close()
            .map_err(|e| format!("Failed to close webview: {e}"))?;
    }

    Ok(())
}

/// Updates webview position and size.
#[command]
pub async fn update_sidebar_webview_bounds(
    app_handle: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri::PhysicalPosition;
    use tauri::PhysicalSize;
    use tauri::{Position, Size};

    if let Some(webview) = app_handle.get_webview_window(&label) {
        webview
            .set_position(Position::Physical(PhysicalPosition {
                x: x as i32,
                y: y as i32,
            }))
            .map_err(|e| format!("Failed to set position: {e}"))?;
        webview
            .set_size(Size::Physical(PhysicalSize {
                width: width as u32,
                height: height as u32,
            }))
            .map_err(|e| format!("Failed to set size: {e}"))?;
    }

    Ok(())
}
