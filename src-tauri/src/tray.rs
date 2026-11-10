/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WindowEvent,
};

/// Native resources live for the app process, including across frontend reloads.
#[derive(Default)]
pub struct TrayState(Mutex<Option<TrayMenu>>);

struct TrayMenu {
    _menu: Menu<tauri::Wry>,
    show: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// Create the app tray once, or refresh its translated labels after frontend initialization.
#[tauri::command]
pub async fn initialize_tray(
    app: AppHandle,
    show_label: String,
    quit_label: String,
) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = initialize(&handle, &show_label, &quit_label);
        let _ = sender.send(result.map_err(|error| error.to_string()));
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

fn initialize(app: &AppHandle, show_label: &str, quit_label: &str) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    let mut menu = state.0.lock().unwrap();
    if let Some(menu) = menu.as_ref() {
        menu.show.set_text(show_label)?;
        menu.quit.set_text(quit_label)?;
        return Ok(());
    }

    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WindowNotFound)?;
    let show = MenuItem::with_id(app, "tray-show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", quit_label, true, None::<&str>)?;
    let native_menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&native_menu)
        .tooltip("Thunderbolt")
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => {
                if let Err(error) = crate::commands::show_main_window(app.clone()) {
                    eprintln!("Could not restore the main window: {error}");
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    // Install this only after tray creation succeeds, so a failed tray cannot strand a hidden app.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = crate::commands::hide_main_window(handle.clone()) {
                eprintln!("Could not hide the main window: {error}");
            }
        }
    });
    *menu = Some(TrayMenu {
        _menu: native_menu,
        show,
        quit,
    });
    Ok(())
}
