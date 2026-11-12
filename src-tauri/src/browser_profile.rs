/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::WebviewBuilder;
use tauri::{Manager, Webview};

/// Keep a failed identity cleanup closed across retries and app restarts.
#[derive(Default)]
pub(crate) struct PendingCleanup(AtomicBool);

impl PendingCleanup {
    pub(crate) fn required(&self, marker: &Path) -> Result<bool, String> {
        if self.0.load(Ordering::SeqCst) {
            return Ok(true);
        }
        marker.try_exists().map_err(|error| error.to_string())
    }

    pub(crate) fn begin(&self, marker: &Path) -> Result<(), String> {
        // Even a full disk must prevent reusing the profile in this process.
        self.0.store(true, Ordering::SeqCst);
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(marker, []).map_err(|error| error.to_string())
    }

    pub(crate) fn finish(&self, marker: &Path) -> Result<(), String> {
        match std::fs::remove_file(marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        self.0.store(false, Ordering::SeqCst);
        Ok(())
    }
}

pub(crate) fn cleanup_marker(caller: &Webview) -> Result<PathBuf, String> {
    Ok(caller
        .app_handle()
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("browser-profile-cleanup.pending"))
}

// This identifies the browser's persistent store, never the privileged app's
// default WKWebsiteDataStore. Changing it would strand existing website data.
#[cfg(target_os = "macos")]
const BROWSER_DATA_STORE: [u8; 16] = [
    0x4f, 0x0f, 0xd0, 0xae, 0x25, 0x45, 0x43, 0xe6, 0x83, 0x51, 0xf6, 0x86, 0x90, 0x04, 0xe9, 0x72,
];

/// Wry falls back to the app's default store before macOS 14; never permit that fallback.
#[cfg(target_os = "macos")]
fn macos_data_store(major_version: isize) -> Option<[u8; 16]> {
    (major_version >= 14).then_some(BROWSER_DATA_STORE)
}

/// Isolate website storage from the privileged app while retaining it between browser sessions.
#[cfg(target_os = "macos")]
pub(crate) fn configure(
    _caller: &Webview,
    builder: WebviewBuilder<tauri::Wry>,
) -> Result<WebviewBuilder<tauri::Wry>, String> {
    let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    Ok(match macos_data_store(version.majorVersion) {
        Some(identifier) => builder.incognito(false).data_store_identifier(identifier),
        // Older macOS has no public API for an isolated persistent WK data store.
        None => builder.incognito(true),
    })
}

/// Both WebKitGTK and WebView2 key persistent profiles by their data directory.
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn configure(
    caller: &Webview,
    builder: WebviewBuilder<tauri::Wry>,
) -> Result<WebviewBuilder<tauri::Wry>, String> {
    let directory = caller
        .app_handle()
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("browser");
    Ok(builder.incognito(false).data_directory(directory))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn unsupported_macos_never_falls_back_to_the_privileged_default_store() {
        for version in [10, 11, 12, 13] {
            assert_eq!(macos_data_store(version), None);
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn supported_macos_keeps_one_named_profile_across_sessions_and_os_updates() {
        for version in [14, 15, 26] {
            assert_eq!(macos_data_store(version), Some(BROWSER_DATA_STORE));
        }
        assert_eq!(
            BROWSER_DATA_STORE
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            "4f0fd0ae254543e68351f6869004e972"
        );
    }

    #[test]
    fn interrupted_cleanup_is_retried_after_restart_until_native_completion() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("cleanup.pending");
        let pending = PendingCleanup::default();
        assert!(!pending.required(&marker).unwrap());
        pending.begin(&marker).unwrap();
        assert!(pending.required(&marker).unwrap());
        let restarted = PendingCleanup::default();
        assert!(restarted.required(&marker).unwrap());
        restarted.begin(&marker).unwrap();
        restarted.finish(&marker).unwrap();
        assert!(!restarted.required(&marker).unwrap());
        assert!(!PendingCleanup::default().required(&marker).unwrap());
    }

    #[test]
    fn marker_write_failure_still_blocks_the_current_process() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("not-a-directory");
        std::fs::write(&parent, []).unwrap();
        let marker = parent.join("cleanup.pending");
        let pending = PendingCleanup::default();
        assert!(pending.begin(&marker).is_err());
        assert!(pending.required(&marker).unwrap());
        std::fs::remove_file(parent).unwrap();
        pending.begin(&marker).unwrap();
        pending.finish(&marker).unwrap();
        assert!(!pending.required(&marker).unwrap());
    }
}
