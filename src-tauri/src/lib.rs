// These modules are used by Tauri's command system through macros
// The compiler can't see the usage, so we allow dead_code warnings
#[allow(dead_code)]
pub mod commands;
#[allow(dead_code)]
pub mod state;

#[cfg(any(feature = "bridge", feature = "libsql", feature = "email", feature = "embeddings"))]
use tauri::Manager;
#[cfg(feature = "bridge")]
use tokio::sync::Mutex;
#[cfg(feature = "bridge")]
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
        .setup(|_app| {
            #[cfg(feature = "bridge")]
            _app.manage(Mutex::new(AppState::default()));
            
            #[cfg(feature = "libsql")]
            _app.manage(tokio::sync::Mutex::new(thunderbolt_libsql::LibsqlState::new()));
            
            #[cfg(feature = "email")]
            _app.manage(tokio::sync::Mutex::new(thunderbolt_email::EmailState::default()));
            
            #[cfg(feature = "embeddings")]
            _app.manage(tokio::sync::Mutex::new(thunderbolt_embeddings::EmbeddingsState::default()));
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::toggle_dock_icon,
            commands::get_env,
            commands::capabilities,
            #[cfg(feature = "bridge")]
            commands::init_bridge,
            #[cfg(feature = "bridge")]
            commands::set_bridge_enabled,
            #[cfg(feature = "bridge")]
            commands::get_bridge_status,
            #[cfg(feature = "bridge")]
            commands::get_bridge_connection_status,
            #[cfg(feature = "libsql")]
            thunderbolt_libsql::init_libsql,
            #[cfg(feature = "libsql")]
            thunderbolt_libsql::execute,
            #[cfg(feature = "libsql")]
            thunderbolt_libsql::select,
            #[cfg(feature = "libsql")]
            thunderbolt_libsql::close,
            #[cfg(feature = "email")]
            thunderbolt_email::init_imap,
            #[cfg(feature = "email")]
            thunderbolt_email::init_imap_sync,
            #[cfg(feature = "email")]
            thunderbolt_email::fetch_inbox,
            #[cfg(feature = "email")]
            thunderbolt_email::fetch_messages,
            #[cfg(feature = "email")]
            thunderbolt_email::list_mailboxes,
            #[cfg(feature = "email")]
            thunderbolt_email::sync_mailbox,
            #[cfg(feature = "embeddings")]
            thunderbolt_embeddings::init_embedder,
            #[cfg(feature = "embeddings")]
            thunderbolt_embeddings::generate_embeddings
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
