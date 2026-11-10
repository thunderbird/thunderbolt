/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuEvent, MenuItem, Submenu};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Webview};

#[derive(Default)]
pub struct BrowserMenuState(Mutex<Option<BrowserMenu>>);

struct BrowserMenu {
    submenu: Submenu<tauri::Wry>,
    items: Vec<MenuItem<tauri::Wry>>,
    active_label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMenuLabels {
    browser: String,
    focus_address: String,
    reload: String,
    back: String,
    forward: String,
    new_tab: String,
    close_tab: String,
    next_tab: String,
    previous_tab: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMenuConfig {
    label: String,
    enabled: bool,
    can_go_back: bool,
    can_go_forward: bool,
    labels: BrowserMenuLabels,
}

#[derive(Clone, Serialize)]
struct BrowserShortcut {
    label: String,
    action: &'static str,
}

fn shortcut_action(id: &str) -> Option<&'static str> {
    match id {
        "browser-focus-address" => Some("focus-address"),
        "browser-reload" => Some("reload"),
        "browser-back" => Some("back"),
        "browser-forward" => Some("forward"),
        "browser-new-tab" => Some("new-tab"),
        "browser-close-tab" => Some("close-tab"),
        "browser-next-tab" => Some("next-tab"),
        "browser-previous-tab" => Some("previous-tab"),
        _ => None,
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(action) = shortcut_action(event.id.as_ref()) else {
        return;
    };
    let state = app.state::<BrowserMenuState>();
    let label = state
        .0
        .lock()
        .ok()
        .and_then(|menu| menu.as_ref().and_then(|menu| menu.active_label.clone()));
    let Some(label) = label.filter(|label| app.get_webview(label).is_some()) else {
        return;
    };
    if matches!(
        action,
        "focus-address" | "new-tab" | "close-tab" | "next-tab" | "previous-tab"
    ) {
        if let Some(main) = app.get_webview("main") {
            if let Err(error) = main.set_focus() {
                eprintln!("Could not focus browser controls: {error}");
                return;
            }
        }
    }
    if let Err(error) = app.emit_to(
        EventTarget::webview("main"),
        "browser-shortcut",
        BrowserShortcut { label, action },
    ) {
        eprintln!("Could not dispatch browser shortcut: {error}");
    }
}

/// Native menu accelerators also work while keyboard focus is inside a remote child webview.
#[tauri::command]
pub async fn browser_configure_shortcuts(
    webview: Webview,
    config: BrowserMenuConfig,
) -> Result<(), String> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("Browser shortcuts are restricted to the main app webview".into());
    }
    if !config.label.starts_with("sidebar-webview-") {
        return Err("Browser shortcut target is invalid".into());
    }
    let app = webview.app_handle().clone();
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(configure_menu(&handle, config));
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

fn configure_menu(app: &AppHandle, config: BrowserMenuConfig) -> Result<(), String> {
    if config.enabled && app.get_webview(&config.label).is_none() {
        return Err("Browser webview is closed".into());
    }
    let state = app.state::<BrowserMenuState>();
    let mut slot = state.0.lock().map_err(|error| error.to_string())?;
    // Late cleanup from an older browser must not disable its replacement.
    if !config.enabled {
        if let Some(menu) = slot.as_mut() {
            if menu
                .active_label
                .as_ref()
                .is_none_or(|label| label == &config.label)
            {
                menu.active_label = None;
                for item in &menu.items {
                    item.set_enabled(false).map_err(|error| error.to_string())?;
                }
            }
        }
        return Ok(());
    }
    if slot.is_none() {
        let back_accelerator = if cfg!(target_os = "macos") {
            "CmdOrCtrl+["
        } else {
            "Alt+Left"
        };
        let forward_accelerator = if cfg!(target_os = "macos") {
            "CmdOrCtrl+]"
        } else {
            "Alt+Right"
        };
        let items = [
            (
                "browser-focus-address",
                &config.labels.focus_address,
                "CmdOrCtrl+L",
            ),
            ("browser-reload", &config.labels.reload, "CmdOrCtrl+R"),
            ("browser-back", &config.labels.back, back_accelerator),
            (
                "browser-forward",
                &config.labels.forward,
                forward_accelerator,
            ),
            ("browser-new-tab", &config.labels.new_tab, "CmdOrCtrl+T"),
            ("browser-close-tab", &config.labels.close_tab, "CmdOrCtrl+W"),
            ("browser-next-tab", &config.labels.next_tab, "Ctrl+Tab"),
            (
                "browser-previous-tab",
                &config.labels.previous_tab,
                "Ctrl+Shift+Tab",
            ),
        ]
        .into_iter()
        .map(|(id, label, accelerator)| MenuItem::with_id(app, id, label, false, Some(accelerator)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
        let submenu =
            Submenu::new(app, &config.labels.browser, true).map_err(|error| error.to_string())?;
        for item in &items {
            submenu.append(item).map_err(|error| error.to_string())?;
        }
        let menu = match app.menu() {
            Some(menu) => menu,
            None => Menu::default(app).map_err(|error| error.to_string())?,
        };
        // Resolve Close Tab before the default Close Window accelerator while browsing.
        let position = usize::from(cfg!(target_os = "macos"));
        menu.insert(&submenu, position)
            .map_err(|error| error.to_string())?;
        app.set_menu(menu).map_err(|error| error.to_string())?;
        // Keep the existing frameless Windows/Linux layout; accelerators remain registered.
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if let Some(window) = app.get_window("main") {
            window.hide_menu().map_err(|error| error.to_string())?;
        }
        app.on_menu_event(on_menu_event);
        *slot = Some(BrowserMenu {
            submenu,
            items,
            active_label: None,
        });
    }
    let menu = slot.as_mut().ok_or("Browser menu initialization failed")?;
    menu.active_label = config.enabled.then_some(config.label);
    menu.submenu
        .set_text(config.labels.browser)
        .map_err(|error| error.to_string())?;
    let labels = [
        config.labels.focus_address,
        config.labels.reload,
        config.labels.back,
        config.labels.forward,
        config.labels.new_tab,
        config.labels.close_tab,
        config.labels.next_tab,
        config.labels.previous_tab,
    ];
    let enabled = [
        config.enabled,
        config.enabled,
        config.enabled && config.can_go_back,
        config.enabled && config.can_go_forward,
        config.enabled,
        config.enabled,
        config.enabled,
        config.enabled,
    ];
    for ((item, label), enabled) in menu.items.iter().zip(labels).zip(enabled) {
        item.set_text(label).map_err(|error| error.to_string())?;
        item.set_enabled(enabled)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::shortcut_action;

    #[test]
    fn routes_tab_shortcuts_without_accepting_unknown_menu_items() {
        assert_eq!(shortcut_action("browser-new-tab"), Some("new-tab"));
        assert_eq!(shortcut_action("browser-close-tab"), Some("close-tab"));
        assert_eq!(shortcut_action("browser-next-tab"), Some("next-tab"));
        assert_eq!(
            shortcut_action("browser-previous-tab"),
            Some("previous-tab")
        );
        assert_eq!(shortcut_action("window-close"), None);
    }
}
