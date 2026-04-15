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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("platform-utils")
        .invoke_handler(tauri::generate_handler![get_android_insets, set_bar_color]);

    #[cfg(target_os = "android")]
    let builder = builder.setup(|_app, api| {
        api.register_android_plugin("net.thunderbird.thunderbolt", "PlatformUtilsPlugin")?;
        Ok(())
    });

    builder.build()
}
