/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use anyhow::Result;
use tauri::command;

/// Dispatch one complete visibility change so close and restore events cannot interleave.
#[cfg(desktop)]
fn set_main_window_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    use tauri::Manager;

    let handle = app.clone();
    app.run_on_main_thread(move || {
        let update = || -> tauri::Result<()> {
            let window = handle
                .get_webview_window("main")
                .ok_or(tauri::Error::WindowNotFound)?;
            if visible {
                #[cfg(target_os = "macos")]
                {
                    handle.set_activation_policy(tauri::ActivationPolicy::Regular)?;
                    handle.show()?;
                }
                window.show()?;
                window.unminimize()?;
                window.set_skip_taskbar(false)?;
                window.set_focus()?;
            } else {
                window.hide()?;
                window.set_skip_taskbar(true)?;
                #[cfg(target_os = "macos")]
                handle.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
            }
            Ok(())
        };
        if let Err(error) = update() {
            eprintln!("Could not set main window visibility to {visible}: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

/// Request restoration from the tray, a second launch, or a macOS Dock click.
/// Returns once dispatched; operation failures are logged on the main thread.
#[command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    set_main_window_visible(app, true)?;
    #[cfg(mobile)]
    let _ = app;

    Ok(())
}

/// Request hiding the window and its taskbar/Dock icon in one main-thread operation.
#[command]
pub fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    set_main_window_visible(app, false)?;
    #[cfg(mobile)]
    let _ = app;

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

// === OAuth loopback server ===================================================================

/// Ports pre-registered as redirect URIs in the Google / Microsoft OAuth console.
const OAUTH_PORTS: &[u16] = &[17421, 17422, 17423];

/// Starts the in-house OAuth loopback server and returns the port it bound to.
///
/// The Rust server rejects unrelated requests and accepts one callback, optionally
/// matching an SSO client state, then emits `"oauth-callback"` and shuts down.
/// No external HTTP framework or Tauri plugin is required.
#[command]
pub async fn start_oauth_server(
    app: tauri::AppHandle,
    client_state: Option<String>,
) -> Result<u16, String> {
    crate::oauth_server::start(app, OAUTH_PORTS, client_state)
}

// === Thunderbolt CLI install =================================================================

/// Download, verify and install the standalone `thunderbolt` CLI into
/// `~/.local/bin`, deriving the release URL from this app's version. Desktop
/// macOS/Linux only — other platforms return `Unsupported` (see [`crate::cli_installer`]).
#[command]
pub async fn install_thunderbolt_cli(
    app: tauri::AppHandle,
) -> Result<crate::cli_installer::CliInstallResult, crate::cli_installer::CliInstallError> {
    let version = app.package_info().version.to_string();
    crate::cli_installer::install_cli(&version).await
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    #[test]
    fn http_capability_is_scoped_to_main_webview_and_http_schemes() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(capability["webviews"], json!(["main"]));
        assert!(capability.get("windows").is_none());
        let http = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|permission| permission["identifier"] == "http:default")
            .unwrap();
        assert_eq!(
            http["allow"],
            json!([{ "url": "http://*:*/*" }, { "url": "https://*:*/*" }])
        );
    }
}
