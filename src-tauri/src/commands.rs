/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

// === Zeus bridge installer ===================================================================

/// The canonical one-liner that installs the `zeus` bridge onto the user's PATH —
/// identical to what the connect dialog shows for manual install. Keep in sync with
/// `installCommand` in `src/lib/agent-bridge-command.ts`.
const ZEUS_INSTALL_CMD: &str =
    "curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/zeus/install.sh | bash";

/// Maps a finished installer process to the renderer-facing result: trimmed stdout
/// on a clean exit, otherwise a message built from stderr (falling back to stdout)
/// and the exit code. Pulled out of the command so it's unit-testable without
/// actually spawning a shell.
fn map_install_output(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(format!(
        "installer exited with status {}: {}",
        output.status.code().unwrap_or(-1),
        detail
    ))
}

/// Runs the `zeus` bridge installer from the desktop connect dialog so the user can
/// install without a terminal. install.sh needs `node`/`npm`/`curl`, so we run it
/// through the user's login shell (`$SHELL -lc`, falling back to `bash`) to pick up
/// their PATH (nvm/brew node), off the async runtime so the UI stays responsive.
/// Best-effort: when the GUI environment lacks node/npm it fails and the dialog
/// surfaces the manual command. macOS/Linux only — Windows and mobile have no POSIX
/// login shell to drive the script.
#[cfg(all(desktop, unix))]
#[command]
pub async fn install_bridge() -> Result<String, String> {
    let output = tauri::async_runtime::spawn_blocking(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        // `set -o pipefail` so a failed `curl` (404 / no network) fails the whole
        // pipeline instead of `bash` succeeding on empty stdin — otherwise a broken
        // download reports a false "installed".
        std::process::Command::new(shell)
            .arg("-lc")
            .arg(format!("set -o pipefail; {ZEUS_INSTALL_CMD}"))
            .output()
    })
    .await
    .map_err(|e| format!("installer task failed: {e}"))?
    .map_err(|e| format!("failed to spawn installer: {e}"))?;

    map_install_output(output)
}

/// Windows desktop and mobile have no POSIX login shell to drive install.sh, so
/// auto-install is unavailable there; the dialog shows the manual command instead.
#[cfg(not(all(desktop, unix)))]
#[command]
pub async fn install_bridge() -> Result<String, String> {
    Err(
        "Automatic install is only available on macOS and Linux. Use the manual command."
            .to_string(),
    )
}

#[cfg(all(test, unix))]
mod install_bridge_tests {
    use super::map_install_output;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    // On Unix the raw wait-status encodes the exit code in the high byte.
    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn success_returns_trimmed_stdout() {
        assert_eq!(
            map_install_output(output(0, "Installed.\n", "")).unwrap(),
            "Installed."
        );
    }

    #[test]
    fn failure_prefers_stderr_and_code() {
        let err = map_install_output(output(1, "", "npm not found")).unwrap_err();
        assert!(err.contains("status 1"));
        assert!(err.contains("npm not found"));
    }

    #[test]
    fn failure_falls_back_to_stdout_when_stderr_empty() {
        let err = map_install_output(output(2, "some detail", "")).unwrap_err();
        assert!(err.contains("some detail"));
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
