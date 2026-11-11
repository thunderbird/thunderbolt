/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::Serialize;
use tauri::{command, plugin::Builder, plugin::TauriPlugin, Runtime};

#[derive(Serialize)]
pub struct AndroidInsets {
    #[serde(rename = "adjustedInsetTop")]
    pub adjusted_inset_top: f64,
    #[serde(rename = "adjustedInsetBottom")]
    pub adjusted_inset_bottom: f64,
}

/// Returns Android edge-to-edge display insets. On Android this is overridden by
/// the Kotlin PlatformUtilsPlugin which reads real WindowInsetsCompat values.
/// On desktop/iOS this Rust fallback returns None.
#[command]
fn get_android_insets() -> Option<AndroidInsets> {
    None
}

/// Sets Android status/navigation bar icon appearance. On Android this is
/// overridden by the Kotlin PlatformUtilsPlugin which calls
/// WindowInsetsControllerCompat. On desktop/iOS this Rust fallback is a no-op.
#[command]
fn set_bar_color(style: String) -> Result<(), String> {
    let _ = style;
    Ok(())
}

/// Saves a file into the public Downloads folder. Implemented by the Kotlin
/// PlatformUtilsPlugin through MediaStore; desktop and iOS save through
/// plugin-fs instead (see `src/lib/download.ts`), so this fallback only reports
/// a misrouted call.
#[cfg(not(target_os = "android"))]
#[command]
fn save_to_downloads(name: String, mime_type: String, data: String) -> Result<(), String> {
    let _ = (mime_type, data);
    Err(format!(
        "Saving {name} to the public Downloads folder is only implemented on Android"
    ))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // A command the Rust handler matches never reaches Kotlin, so
    // save_to_downloads must not be registered here on Android.
    let builder = Builder::new("platform-utils").invoke_handler(tauri::generate_handler![
        get_android_insets,
        set_bar_color,
        #[cfg(not(target_os = "android"))]
        save_to_downloads
    ]);

    #[cfg(target_os = "android")]
    let builder = builder.setup(|_app, api| {
        api.register_android_plugin("net.thunderbird.thunderbolt", "PlatformUtilsPlugin")?;
        Ok(())
    });

    builder.build()
}
