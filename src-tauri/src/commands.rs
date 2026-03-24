use anyhow::Result;
use serde::Serialize;
use tauri::command;

#[cfg(feature = "bridge")]
use crate::state::AppState;
#[cfg(feature = "bridge")]
use serde_json;
#[cfg(feature = "bridge")]
use tauri::Manager;
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

// === Interface Style (iOS keyboard/system UI theme) ==========================================

/// Set the native user interface style on iOS to control keyboard and system UI appearance.
/// Android keyboards follow the system dark mode setting and cannot be overridden per-app.
/// Desktop: no-op.
/// style: "system" | "light" | "dark"
#[command]
pub fn set_interface_style(style: String) {
    #[cfg(target_os = "ios")]
    {
        use objc2_foundation::MainThreadMarker;
        use objc2_ui_kit::{UIApplication, UIUserInterfaceStyle, UIWindowScene};

        let ui_style = match style.as_str() {
            "light" => UIUserInterfaceStyle::Light,
            "dark" => UIUserInterfaceStyle::Dark,
            _ => UIUserInterfaceStyle::Unspecified,
        };

        if let Some(mtm) = MainThreadMarker::new() {
            let app = UIApplication::sharedApplication(mtm);
            for scene in app.connectedScenes() {
                if let Some(window_scene) = scene.downcast_ref::<UIWindowScene>() {
                    for window in window_scene.windows() {
                        window.setOverrideUserInterfaceStyle(ui_style);
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = style;
    }
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

// === OAuth loopback server ===================================================================

/// Ports pre-registered as redirect URIs in the Google / Microsoft OAuth console.
const OAUTH_PORTS: &[u16] = &[17421, 17422, 17423];

/// Starts the in-house OAuth loopback server and returns the port it bound to.
///
/// The Rust server accepts one HTTP connection, sends an "Authentication Complete"
/// response, emits an `"oauth-callback"` event to the frontend, then shuts down.
/// No external HTTP framework or Tauri plugin is required.
#[command]
pub async fn start_oauth_server(app: tauri::AppHandle) -> Result<u16, String> {
    crate::oauth_server::start(app, OAUTH_PORTS)
}
