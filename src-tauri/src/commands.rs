use anyhow::Result;
use serde::Serialize;
use tauri::command;

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

// === Interface Style (iOS keyboard/system UI theme) ==========================================

/// Set the native user interface style on iOS to control keyboard and system UI appearance.
/// Android keyboards follow the system dark mode setting and cannot be overridden per-app.
/// Desktop: no-op.
/// style: "system" | "light" | "dark"
#[command]
pub fn set_interface_style(style: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use objc2_foundation::MainThreadMarker;
        use objc2_ui_kit::{UIApplication, UIUserInterfaceStyle, UIWindowScene};

        let ui_style = match style.as_str() {
            "light" => UIUserInterfaceStyle::Light,
            "dark" => UIUserInterfaceStyle::Dark,
            _ => UIUserInterfaceStyle::Unspecified,
        };

        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "set_interface_style must run on the main thread".to_string())?;

        let app = UIApplication::sharedApplication(mtm);
        for scene in app.connectedScenes() {
            if let Some(window_scene) = scene.downcast_ref::<UIWindowScene>() {
                for window in window_scene.windows() {
                    window.setOverrideUserInterfaceStyle(ui_style);
                }
            }
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = style;
    }

    Ok(())
}

// === Android bar color & insets ===============================================================

/// Set the Android status bar and navigation bar icon appearance.
/// style: "dark" (dark icons on light bg) | "light" (light icons on dark bg)
/// No-op on non-Android platforms.
#[command]
pub fn set_bar_color(style: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // Android implementation is handled via the Kotlin plugin bridge.
        // For now this is a placeholder — the Kotlin side will be wired up
        // when android-specific native code is added.
        let _ = style;
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = style;
    }

    Ok(())
}

/// Returns the Android edge-to-edge display insets (safe area padding).
/// Returns null on non-Android platforms.
#[derive(Serialize)]
pub struct AndroidInsets {
    #[serde(rename = "adjustedInsetTop")]
    pub adjusted_inset_top: f64,
    #[serde(rename = "adjustedInsetBottom")]
    pub adjusted_inset_bottom: f64,
}

#[command]
pub fn get_android_insets() -> Option<AndroidInsets> {
    #[cfg(target_os = "android")]
    {
        // Android implementation is handled via the Kotlin plugin bridge.
        // For now this is a placeholder — the Kotlin side will be wired up
        // when android-specific native code is added.
        None
    }

    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

// === Capabilities ============================================================================

/// List of runtime capabilities that the renderer can query once and cache.
/// Extend this struct whenever we add more feature flags.
#[derive(Serialize)]
pub struct Capabilities {
    /// Whether the application was compiled with the `native_fetch` feature and therefore the
    /// `tauri-plugin-http` plugin is available for native HTTP requests.
    pub native_fetch: bool,
}

#[cfg(feature = "native_fetch")]
const NATIVE_FETCH_ENABLED: bool = true;
#[cfg(not(feature = "native_fetch"))]
const NATIVE_FETCH_ENABLED: bool = false;

/// Returns the set of capabilities supported by the current build.
#[command]
pub fn capabilities() -> Capabilities {
    Capabilities {
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
