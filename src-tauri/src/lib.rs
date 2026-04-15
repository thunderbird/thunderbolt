// These modules are used by Tauri's command system through macros
// The compiler can't see the usage, so we allow dead_code warnings
#[allow(dead_code)]
pub mod commands;
pub mod oauth_server;
pub mod platform_utils;

use tauri::Manager;

// Shared app builder function
pub fn create_app() -> tauri::Builder<tauri::Wry> {
    let mut builder = tauri::Builder::default();

    // Single-instance: focus existing window when a second instance is launched (desktop only)
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    // Core plugins that are always enabled
    builder = builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_haptics::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(platform_utils::init())
        .invoke_handler(tauri::generate_handler![
            commands::toggle_dock_icon,
            commands::capabilities,
            commands::set_interface_style,
            commands::start_oauth_server,
        ]);

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_devtools::init());
    }

    builder
}

// Android/iOS entry point for Tauri 2 mobile builds
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::env::set_var("RUST_BACKTRACE", "1");

    create_app()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
