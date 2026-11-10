/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// These modules are used by Tauri's command system through macros
// The compiler can't see the usage, so we allow dead_code warnings
pub mod agent_execution;
mod agent_output_files;
#[cfg(desktop)]
mod browser;
#[cfg(desktop)]
mod browser_control;
#[cfg(target_os = "macos")]
mod browser_focus_macos;
#[cfg(desktop)]
mod browser_menu;
#[cfg(desktop)]
mod browser_operation;
#[cfg(desktop)]
mod browser_presentation;
#[cfg(desktop)]
mod browser_resize;
pub mod cli_installer;
#[allow(dead_code)]
pub mod commands;
pub mod oauth_server;
pub mod page_preview;
pub mod platform_utils;
#[cfg(desktop)]
mod tray;

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "ios"))]
use tauri::Manager;

// Shared app builder function
pub fn create_app() -> tauri::Builder<tauri::Wry> {
    let mut builder = tauri::Builder::default();

    // Single-instance: focus existing window when a second instance is launched (desktop only)
    #[cfg(desktop)]
    {
        builder = builder
            .manage(tray::TrayState::default())
            .manage(browser::BrowserRegistry::default())
            .manage(browser_menu::BrowserMenuState::default())
            .manage(browser_resize::BrowserResizeState::default())
            .on_page_load(|webview, payload| {
                if webview.label() == "main"
                    && payload.event() == tauri::webview::PageLoadEvent::Started
                {
                    browser::main_page_started(webview);
                    browser_resize::main_page_started(webview);
                }
            });
        builder = builder.plugin(tauri_plugin_dialog::init());
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = commands::show_main_window(app.clone()) {
                eprintln!("Could not restore the main window: {error}");
            }
        }));
    }

    // Core plugins that are always enabled
    builder = builder
        .manage(page_preview::PreviewSessions::default())
        .manage(agent_execution::Commands::default())
        .manage(agent_output_files::OutputFiles::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                // The main renderer handles external links itself. Global injection would
                // swallow browser child views' _blank links, whose opener IPC is denied.
                .open_js_links_on_click(!cfg!(desktop))
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_haptics::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_passkey::init())
        .plugin(tauri_plugin_pages::init())
        .plugin(platform_utils::init())
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                #[cfg(desktop)]
                browser::browser_create,
                #[cfg(desktop)]
                browser_presentation::browser_present,
                #[cfg(desktop)]
                browser_presentation::browser_set_visibility,
                #[cfg(desktop)]
                browser::browser_navigate,
                #[cfg(desktop)]
                browser::browser_action,
                #[cfg(desktop)]
                browser::browser_get_state,
                #[cfg(desktop)]
                browser::browser_close,
                #[cfg(desktop)]
                browser_control::browser_agent_snapshot,
                #[cfg(desktop)]
                browser_control::browser_agent_action,
                #[cfg(desktop)]
                browser_control::browser_begin_agent_action,
                #[cfg(desktop)]
                browser_control::browser_cancel_agent_action,
                #[cfg(desktop)]
                browser_control::browser_set_picker,
                #[cfg(desktop)]
                browser_control::browser_poll_picker,
                #[cfg(desktop)]
                browser_menu::browser_configure_shortcuts,
                #[cfg(desktop)]
                browser_resize::browser_resize_update,
                #[cfg(desktop)]
                browser_resize::browser_resize_drag,
                #[cfg(desktop)]
                browser_resize::browser_resize_raise,
                page_preview::agent_preview_start,
                page_preview::agent_preview_status,
                page_preview::agent_preview_stop,
                agent_execution::agent_pick_workspace,
                agent_execution::agent_fs,
                agent_execution::agent_cleanup_output_files,
                agent_execution::agent_prepare_command,
                agent_execution::agent_cancel_command,
                agent_execution::agent_forget_command,
                agent_execution::agent_exec,
                commands::show_main_window,
                commands::hide_main_window,
                #[cfg(desktop)]
                tray::initialize_tray,
                commands::set_interface_style,
                commands::start_oauth_server,
                commands::stop_oauth_server,
                commands::install_thunderbolt_cli,
            ];
            move |invoke| {
                #[cfg(desktop)]
                if invoke.message.webview().label() == "browser-resize-handle"
                    && invoke.message.command() != "browser_resize_drag"
                {
                    invoke
                        .resolver
                        .reject("Only resize gestures are available to the browser grip");
                    return true;
                }
                handler(invoke)
            }
        });

    #[cfg(debug_assertions)]
    {
        // tauri-plugin-devtools pulls in reqwest 0.13 (rustls). On iOS dev builds the rustls
        // stack panics on first HTTPS call without an explicit crypto provider — release builds
        // exclude this plugin entirely so they're unaffected.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        builder = builder.plugin(tauri_plugin_devtools::init());
    }

    // macOS window vibrancy is configured declaratively in tauri.macos.conf.json
    // (`windowEffects: hudWindow` + `transparent` + `macOSPrivateApi` +
    // `titleBarStyle: Overlay` for the overlaid traffic lights), a platform
    // config Tauri auto-merges over the opaque base window in tauri.conf.json.
    // These are scoped to macOS on purpose: a transparent WebView2 window would
    // break compositing on Windows (dead scrollbars). The frontend keeps the
    // main content pane opaque and paints the left sidebar translucent so only
    // it reads as glass (see `.mac-vibrancy` in src/index.css).
    // `followsWindowActiveState` flattens the blur while the window is inactive,
    // matching native macOS apps.

    // Frameless main window on Windows/Linux: hide the native title bar and let
    // the frontend paint its own min/maximize/close controls at the top-right
    // (`WindowControls`), matching the platform convention while keeping the
    // opaque, edge-to-edge canvas. macOS uses `titleBarStyle: Overlay` from
    // tauri.macos.conf.json instead — setting `decorations: false` there would
    // strip the native traffic lights, so the borderless flag is scoped to the
    // custom-controls platforms.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }
            Ok(())
        });
    }

    // WebKitGTK's WASM optimizing JIT tier (OMG) leaks native memory when repeatedly
    // recompiling wa-sqlite's WASM module (used via IDBBatchAtomicVFS, PowerSync's OPFS
    // fallback on this platform - see getPowerSyncOptions in src/db/powersync/database.ts),
    // eventually OOM-killing the WebKitWebProcess. Disabling just the OMG tier (baseline
    // JIT stays on) avoids it. Must be set before the webview is created, since WebKitGTK
    // reads JSC_* env vars at its own init time. Remove once upstream WebKit fixes this
    // (tracked at https://bugs.webkit.org/show_bug.cgi?id=319572).
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("JSC_useOMGJIT", "false");
    }

    // `transparent: true` now lives only in tauri.macos.conf.json, so the iOS
    // WKWebView is opaque by default. This belt-and-suspenders call keeps it
    // opaque regardless: a non-opaque webview would let the root view
    // controller's systemBackgroundColor — white in light mode, black in dark —
    // bleed through the status-bar and home-indicator safe areas, so the status
    // bar reads as white on the light theme. Forcing opaque makes those regions
    // paint the web canvas (the themed --color-background) instead.
    #[cfg(target_os = "ios")]
    {
        builder = builder.setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    use objc2_ui_kit::UIView;
                    // SAFETY: on iOS `inner()` returns the WKWebView, a UIView subclass.
                    unsafe {
                        let view = &*(webview.inner() as *const UIView);
                        view.setOpaque(true);
                    }
                });
            }
            Ok(())
        });
    }

    builder
}

// Android/iOS entry point for Tauri 2 mobile builds
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::env::set_var("RUST_BACKTRACE", "1");

    create_app()
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            if matches!(_event, tauri::RunEvent::Exit) {
                page_preview::shutdown(_app);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Err(error) = commands::show_main_window(_app.clone()) {
                    eprintln!("Could not restore the main window: {error}");
                }
            }
        });
}
