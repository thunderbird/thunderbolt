// These modules are used by Tauri's command system through macros
// The compiler can't see the usage, so we allow dead_code warnings
#[allow(dead_code)]
pub mod commands;
#[allow(dead_code)]
pub mod db_pool;
#[allow(dead_code)]
pub mod embedding;
#[allow(dead_code)]
pub mod libsql;
pub mod settings;
#[allow(dead_code)]
pub mod state;

use tauri::{Manager};
use tokio::sync::Mutex;
use crate::state::AppState;

// Shared app builder function
pub fn create_app() -> tauri::Builder<tauri::Wry> {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            app.manage(Mutex::new(AppState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::toggle_dock_icon,
            libsql::init_libsql,
            libsql::execute,
            libsql::select,
            commands::init_imap,
            commands::init_imap_sync,
            commands::fetch_inbox,
            commands::fetch_messages,
            commands::list_mailboxes,
            commands::sync_mailbox,
            embedding::generate_embeddings,
            embedding::init_embedder,
            commands::get_env,
            commands::init_bridge,
            commands::set_bridge_enabled,
            commands::get_bridge_status,
            commands::get_bridge_connection_status
        ]);

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_devtools::init());
    }

    builder
}

// For iOS - this is the function that the iOS bindings expect
#[no_mangle]
pub extern "C" fn start_app() {
    std::env::set_var("RUST_BACKTRACE", "1");
    
    tauri::async_runtime::block_on(async {
        create_app()
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    });
}
