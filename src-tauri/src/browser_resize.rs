/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, PlatformWebview, WebviewBuilder};
use tauri::{
    Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl,
};

const LABEL: &str = "browser-resize-handle";
const WIDTH: f64 = 24.0;
const HEIGHT: f64 = 40.0;

#[derive(Default)]
pub struct BrowserResizeState {
    updates: tokio::sync::Mutex<()>,
    session: Mutex<Option<Session>>,
    page_generation: AtomicU64,
}

/// Native children outlive a renderer reload, whose async JS cleanup is not guaranteed to run.
pub(crate) fn main_page_started(webview: &Webview) {
    let state = webview.state::<BrowserResizeState>();
    let generation = state.page_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let webview = webview.clone();
    tauri::async_runtime::spawn(async move {
        let state = webview.state::<BrowserResizeState>();
        let _updates = state.updates.lock().await;
        if state.page_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let Ok(mut session) = state.session.lock() else {
            return;
        };
        // The next document may have already installed its own grip before this
        // asynchronous cleanup acquired the update lock. Preserve that session.
        if session
            .as_ref()
            .is_some_and(|session| session.page_generation == generation)
        {
            return;
        }
        if let Some(grip) = webview.get_webview(LABEL) {
            if let Err(error) = grip.close() {
                eprintln!("Could not close stale browser resize grip: {error}");
            }
        }
        *session = None;
    });
}

struct Session {
    owner: String,
    page_generation: u64,
    gesture: Option<u32>,
    colors: ResizeColors,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub struct ResizeColors {
    background: String,
    foreground: String,
    border: String,
    hover: String,
}

#[derive(Deserialize)]
pub struct ResizePresentation {
    x: f64,
    y: f64,
    colors: ResizeColors,
    label: String,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DragPhase {
    Start,
    Move,
    End,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeInput {
    owner: String,
    gesture: u32,
    phase: DragPhase,
    screen_x: f64,
}

fn authorize(caller: &Webview, label: &str) -> Result<(), String> {
    if caller.label() != label || caller.window().label() != "main" {
        return Err("Browser resize command is not available to this webview".into());
    }
    Ok(())
}

fn valid_owner(owner: &str) -> bool {
    (1..=64).contains(&owner.len())
        && owner
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || character == b'-')
}

fn validate_input(session: &mut Session, input: &ResizeInput) -> Result<(), String> {
    if session.owner != input.owner || !input.screen_x.is_finite() || input.screen_x.abs() > 65536.0
    {
        return Err("Invalid browser resize gesture".into());
    }
    match input.phase {
        DragPhase::Start => session.gesture = Some(input.gesture),
        DragPhase::Move | DragPhase::End if session.gesture != Some(input.gesture) => {
            return Err("Browser resize gesture is no longer active".into());
        }
        DragPhase::End => session.gesture = None,
        DragPhase::Move => {}
    }
    Ok(())
}

/// A tiny trusted child surface keeps the grip above native pages without reserving a gutter.
#[tauri::command]
pub async fn browser_resize_update(
    webview: Webview,
    state: State<'_, BrowserResizeState>,
    owner: String,
    presentation: Option<ResizePresentation>,
) -> Result<(), String> {
    authorize(&webview, "main")?;
    if !valid_owner(&owner) {
        return Err("Invalid browser resize owner".into());
    }
    let generation = state.page_generation.load(Ordering::SeqCst);
    let _updates = state.updates.lock().await;
    if state.page_generation.load(Ordering::SeqCst) != generation {
        return Err("Browser resize owner was reloaded".into());
    }
    let Some(presentation) = presentation else {
        let mut session = state.session.lock().map_err(|error| error.to_string())?;
        if session
            .as_ref()
            .is_some_and(|session| session.owner == owner)
        {
            if let Some(grip) = webview.get_webview(LABEL) {
                grip.close().map_err(|error| error.to_string())?;
            }
            *session = None;
        }
        return Ok(());
    };
    let size = webview
        .window()
        .inner_size()
        .map_err(|error| error.to_string())?;
    let scale = webview
        .window()
        .scale_factor()
        .map_err(|error| error.to_string())?;
    if !presentation.x.is_finite()
        || !presentation.y.is_finite()
        || presentation.x < 0.0
        || presentation.y < 0.0
        || presentation.x + WIDTH > size.width as f64 / scale + 1.0
        || presentation.y + HEIGHT > size.height as f64 / scale + 1.0
        || presentation.label.len() > 160
        || [
            &presentation.colors.background,
            &presentation.colors.foreground,
            &presentation.colors.border,
            &presentation.colors.hover,
        ]
        .iter()
        .any(|color| color.len() > 160)
    {
        return Err("Invalid browser resize presentation".into());
    }
    let replace = state
        .session
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .is_some_and(|session| session.owner != owner);
    if replace {
        if let Some(grip) = webview.get_webview(LABEL) {
            grip.close().map_err(|error| error.to_string())?;
        }
    }
    let grip = match webview.get_webview(LABEL) {
        Some(grip) => {
            grip.set_position(LogicalPosition::new(presentation.x, presentation.y))
                .map_err(|error| error.to_string())?;
            let changed = state
                .session
                .lock()
                .map_err(|error| error.to_string())?
                .as_ref()
                .is_none_or(|session| session.colors != presentation.colors);
            if changed {
                grip.eval(format!(
                    "window.__browserResizeStyle?.({});",
                    serde_json::to_string(&presentation.colors)
                        .map_err(|error| error.to_string())?
                ))
                .map_err(|error| error.to_string())?;
            }
            grip
        }
        None => {
            let expected_url = webview
                .url()
                .map_err(|error| error.to_string())?
                .join("/browser-resize-handle.html")
                .map_err(|error| error.to_string())?;
            let configuration = serde_json::json!({ "owner": owner, "colors": presentation.colors, "label": presentation.label });
            let builder =
                WebviewBuilder::new(LABEL, WebviewUrl::App("browser-resize-handle.html".into()))
                    .transparent(true)
                    .focused(false)
                    .disable_drag_drop_handler()
                    .on_navigation(move |url| url == &expected_url)
                    .on_new_window(|_, _| NewWindowResponse::Deny)
                    .initialization_script(format!(
                        "window.__browserResizeConfiguration = {configuration};\n{}",
                        include_str!("browser_resize.js")
                    ));
            webview
                .window()
                .add_child(
                    builder,
                    LogicalPosition::new(presentation.x, presentation.y),
                    LogicalSize::new(WIDTH, HEIGHT),
                )
                .map_err(|error| error.to_string())?
        }
    };
    {
        let mut session = state.session.lock().map_err(|error| error.to_string())?;
        let gesture = session
            .as_ref()
            .filter(|session| session.owner == owner)
            .and_then(|session| session.gesture);
        *session = Some(Session {
            owner,
            page_generation: generation,
            gesture,
            colors: presentation.colors,
        });
    }
    grip.show().map_err(|error| error.to_string())?;
    crate::browser::with_native(&grip, raise_native).await
}

/// The grip can only emit bounded resize gestures, never arbitrary app messages or commands.
#[tauri::command]
pub fn browser_resize_drag(
    webview: Webview,
    state: State<'_, BrowserResizeState>,
    input: ResizeInput,
) -> Result<(), String> {
    authorize(&webview, LABEL)?;
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    let session = session.as_mut().ok_or("Browser resize grip is closed")?;
    validate_input(session, &input)?;
    webview
        .emit_to(EventTarget::webview("main"), "browser-resize-drag", input)
        .map_err(|error| error.to_string())
}

/// New or newly shown tabs must stay below the grip, without changing keyboard focus.
#[tauri::command]
pub async fn browser_resize_raise(webview: Webview) -> Result<(), String> {
    authorize(&webview, "main")?;
    raise(&webview).await
}

pub(crate) async fn raise(caller: &Webview) -> Result<(), String> {
    if let Some(grip) = caller.get_webview(LABEL) {
        crate::browser::with_native(&grip, raise_native).await?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn raise_native(native: PlatformWebview) -> Result<(), String> {
    use objc2_app_kit::{NSView, NSWindowOrderingMode};
    // SAFETY: Tauri provides a live NSView on its UI thread; reordering never requests focus.
    let view = unsafe { &*(native.inner() as *const NSView) };
    if let Some(parent) = unsafe { view.superview() } {
        parent.addSubview_positioned_relativeTo(view, NSWindowOrderingMode::Above, None);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn raise_native(native: PlatformWebview) -> Result<(), String> {
    use gtk::prelude::*;
    if let Some(window) = native.inner().window() {
        window.raise();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn raise_native(native: PlatformWebview) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    // SAFETY: this controller and its child container belong to the current native UI thread.
    unsafe {
        let mut container = HWND::default();
        native
            .controller()
            .ParentWindow(&mut container)
            .map_err(|error| error.to_string())?;
        SetWindowPos(
            container,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            owner: "owner".into(),
            page_generation: 0,
            gesture: None,
            colors: ResizeColors {
                background: "white".into(),
                foreground: "gray".into(),
                border: "gray".into(),
                hover: "silver".into(),
            },
        }
    }

    #[test]
    fn validates_gesture_lifetime_and_owner() {
        let mut state = session();
        let mut input = ResizeInput {
            owner: "owner".into(),
            gesture: 1,
            phase: DragPhase::Move,
            screen_x: 100.0,
        };
        assert!(validate_input(&mut state, &input).is_err());
        input.phase = DragPhase::Start;
        assert!(validate_input(&mut state, &input).is_ok());
        input.owner = "stale".into();
        assert!(validate_input(&mut state, &input).is_err());
        input.owner = "owner".into();
        input.phase = DragPhase::End;
        assert!(validate_input(&mut state, &input).is_ok());
        assert!(validate_input(&mut state, &input).is_err());
    }

    #[test]
    fn rejects_unbounded_coordinates_and_invalid_owner_tokens() {
        for screen_x in [f64::NAN, f64::INFINITY, -65537.0, 65537.0] {
            let input = ResizeInput {
                owner: "owner".into(),
                gesture: 1,
                phase: DragPhase::Start,
                screen_x,
            };
            assert!(validate_input(&mut session(), &input).is_err());
        }
        assert!(valid_owner("resize-123"));
        for owner in ["", "a/b", "remote page"] {
            assert!(!valid_owner(owner));
        }
    }
}
