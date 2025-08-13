use anyhow::Result;
use tauri::{command, path::BaseDirectory, Manager};
use serde::Serialize;
use std::{process::Command, env::current_exe};

#[cfg(feature = "bridge")]
use tauri::Manager;
#[cfg(feature = "bridge")]
use tokio::sync::Mutex;
#[cfg(feature = "bridge")]
use serde_json;
#[cfg(feature = "bridge")]
use crate::state::AppState;

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
pub fn run_schedule_installer(app_handle: tauri::AppHandle, mut args: Vec<String>) -> Result<(), String> {
    let app_path = current_exe().unwrap();
    args.push(app_path.to_string_lossy().to_string());

    #[cfg(target_os = "linux")]
    {
        let script_path = app_handle.path().resolve("resources/install-schedule-linux.sh", BaseDirectory::Resource)
            .expect("Failed to resolve resource for script path.");

        let output = Command::new("sh")
            .arg(script_path)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let error_message = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Script failed: {}", error_message));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let script_path = app_handle.path().resolve("resources/install-schedule-macos.sh", BaseDirectory::Resource)
            .expect("Failed to resolve resource for script path.");

        let output = Command::new("sh")
            .arg(script_path)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let error_message = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Script failed: {}", error_message));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let script_path = app_handle.path().resolve("resources/install-schedule-windows.ps1", BaseDirectory::Resource)
            .expect("Failed to resolve resource for script path.");

        let output = Command::new("powershell")
            .args(&["-ExecutionPolicy", "Bypass"
            .arg("-File")
            .arg(script_path)
            .args(args)
            .args(&[
                "-Silent",      // No prompts
                "-Force",       // Auto-replace
                "-Json",        // Structured output
                "-TaskName",
                "Ghostcat.Daily"
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let error_message = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Script failed: {}", error_message));
        }

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
        server.set_enabled(enabled).await
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
