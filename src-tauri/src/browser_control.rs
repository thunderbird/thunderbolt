/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::browser::{browser, control_lock, BrowserRegistry};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{State, Webview};

const PAGE_DRIVER: &str = include_str!("../../src/browser/page-driver.js");
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum AgentAction {
    Click {
        r#ref: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        button: Option<MouseButton>,
    },
    Move {
        r#ref: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
    },
    Type {
        text: String,
        r#ref: Option<String>,
        clear: Option<bool>,
    },
    Key {
        key: String,
    },
    Scroll {
        x: Option<f64>,
        y: Option<f64>,
        #[serde(rename = "deltaX")]
        delta_x: Option<f64>,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
}

#[derive(Clone, Copy, Deserialize)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Deserialize)]
struct Viewport {
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
struct PreparedAction {
    point: Option<Point>,
    viewport: Viewport,
}

fn validate_action(action: &AgentAction) -> Result<(), String> {
    let coordinates = |x: Option<f64>, y: Option<f64>| -> Result<(), String> {
        if x.is_some() != y.is_some()
            || [x, y]
                .into_iter()
                .flatten()
                .any(|n| !n.is_finite() || n < 0.0)
        {
            return Err("Browser coordinates must be a pair of finite nonnegative numbers".into());
        }
        Ok(())
    };
    match action {
        AgentAction::Click { r#ref, x, y, .. } | AgentAction::Move { r#ref, x, y } => {
            coordinates(*x, *y)?;
            if r#ref.is_some() == x.is_some()
                || r#ref
                    .as_ref()
                    .is_some_and(|value| value.is_empty() || value.len() > 256)
            {
                return Err("Provide either an element reference or viewport coordinates".into());
            }
        }
        AgentAction::Type { text, r#ref, .. } => {
            if text.len() > 100_000
                || text.contains('\0')
                || r#ref
                    .as_ref()
                    .is_some_and(|value| value.is_empty() || value.len() > 256)
            {
                return Err("Browser text or element reference exceeds its limit".into());
            }
        }
        AgentAction::Key { key } => {
            if key.is_empty() || key.len() > 100 || key.contains('\0') {
                return Err("A supported key or key combination is required".into());
            }
        }
        AgentAction::Scroll {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            coordinates(*x, *y)?;
            if !delta_y.is_finite()
                || delta_y.abs() > 100_000.0
                || delta_x.is_some_and(|n| !n.is_finite() || n.abs() > 100_000.0)
            {
                return Err("Scroll deltas must be finite and at most 100000 pixels".into());
            }
        }
    }
    Ok(())
}

fn validate_prepared(prepared: &PreparedAction) -> Result<(), String> {
    let Viewport { width, height } = prepared.viewport;
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > 100_000.0
        || height > 100_000.0
    {
        return Err("Browser viewport is unavailable".into());
    }
    if prepared.point.is_some_and(|point| {
        !point.x.is_finite()
            || !point.y.is_finite()
            || point.x < 0.0
            || point.y < 0.0
            || point.x >= width
            || point.y >= height
    }) {
        return Err("Browser coordinates are outside the tab viewport".into());
    }
    Ok(())
}

/// Only fixed internal expressions reach this evaluator; page content receives no IPC capabilities.
async fn evaluate(webview: &Webview, expression: &str) -> Result<Value, String> {
    let script = format!(
        "(()=>{{try{{{PAGE_DRIVER}\nreturn {{ok:true,value:({expression})}};}}catch(error){{return {{ok:false,error:String(error?.message ?? error)}};}}}})()"
    );
    let (send, receive) = tokio::sync::oneshot::channel();
    let send = Arc::new(Mutex::new(Some(send)));
    webview
        .eval_with_callback(script, move |result| {
            if let Ok(mut send) = send.lock() {
                if let Some(send) = send.take() {
                    let _ = send.send(result);
                }
            }
        })
        .map_err(|error| error.to_string())?;
    let raw = tokio::time::timeout(OPERATION_TIMEOUT, receive)
        .await
        .map_err(|_| "Browser operation timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if raw.len() > 2 * 1024 * 1024 {
        return Err("Browser response exceeds the 2 MiB observation limit".into());
    }
    let response: Value =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid browser response: {error}"))?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Browser operation failed")
            .to_string());
    }
    Ok(response.get("value").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn browser_agent_snapshot(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
    screenshot: bool,
) -> Result<Value, String> {
    let tab = browser(&webview, &label)?;
    let lock = control_lock(&registry, &label)?;
    let _operation = lock.lock().await;
    let mut snapshot = evaluate(&tab, "window.__thunderboltBrowserDriver.snapshot()").await?;
    let object = snapshot
        .as_object_mut()
        .ok_or("Browser snapshot must be an object")?;
    object.insert(
        "capabilities".into(),
        json!({"nativeInput": true, "screenshot": true}),
    );
    if screenshot {
        object.insert(
            "screenshot".into(),
            screenshot_dimensions(native_screenshot(&tab).await?)?,
        );
    }
    Ok(snapshot)
}

/// PNG dimensions let the agent map high-density image pixels to CSS viewport coordinates.
fn screenshot_dimensions(mut screenshot: Value) -> Result<Value, String> {
    let data = screenshot
        .get("data")
        .and_then(Value::as_str)
        .ok_or("Browser screenshot has no PNG data")?;
    let header = data
        .get(..32)
        .ok_or("Browser screenshot PNG is incomplete")?;
    let header = base64::engine::general_purpose::STANDARD
        .decode(header)
        .map_err(|error| error.to_string())?;
    if header.len() != 24 || &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return Err("Browser screenshot is not a PNG image".into());
    }
    screenshot["width"] = json!(u32::from_be_bytes(
        header[16..20].try_into().map_err(|_| "Invalid PNG width")?
    ));
    screenshot["height"] = json!(u32::from_be_bytes(
        header[20..24]
            .try_into()
            .map_err(|_| "Invalid PNG height")?
    ));
    Ok(screenshot)
}

#[tauri::command]
pub async fn browser_agent_action(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
    action: AgentAction,
) -> Result<Value, String> {
    let tab = browser(&webview, &label)?;
    let lock = control_lock(&registry, &label)?;
    validate_action(&action)?;
    let _operation = lock.lock().await;
    // DOM focus can ask AppKit to change responders asynchronously, before native input runs.
    #[cfg(target_os = "macos")]
    crate::browser_focus_macos::protect_tab(&tab).await?;
    let action_json = serde_json::to_string(&action).map_err(|error| error.to_string())?;
    let prepared = evaluate(&tab, &format!("({{point:window.__thunderboltBrowserDriver.prepare({action_json}),viewport:{{width:innerWidth,height:innerHeight}}}})")).await?;
    let prepared: PreparedAction = serde_json::from_value(prepared)
        .map_err(|error| format!("Invalid browser action target: {error}"))?;
    validate_prepared(&prepared)?;
    if let Some(point) = prepared.point {
        evaluate(
            &tab,
            &format!(
                "window.__thunderboltBrowserDriver.cursor({},{},{})",
                point.x,
                point.y,
                matches!(action, AgentAction::Click { .. })
            ),
        )
        .await?;
    }
    native_input(&tab, action, prepared).await?;
    Ok(json!({"ok":true}))
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 200 {
        return Err("A valid browser picker request ID is required".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_set_picker(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
    enabled: bool,
    request_id: String,
) -> Result<Value, String> {
    let tab = browser(&webview, &label)?;
    let lock = control_lock(&registry, &label)?;
    validate_request_id(&request_id)?;
    let _operation = lock.lock().await;
    evaluate(
        &tab,
        &format!(
            "window.__thunderboltBrowserDriver.setPicker({enabled},{})",
            serde_json::to_string(&request_id).map_err(|error| error.to_string())?
        ),
    )
    .await
}

#[tauri::command]
pub async fn browser_poll_picker(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
    request_id: String,
) -> Result<Value, String> {
    let tab = browser(&webview, &label)?;
    let lock = control_lock(&registry, &label)?;
    validate_request_id(&request_id)?;
    let _operation = lock.lock().await;
    evaluate(
        &tab,
        &format!(
            "window.__thunderboltBrowserDriver.takePick({})",
            serde_json::to_string(&request_id).map_err(|error| error.to_string())?
        ),
    )
    .await
}

#[cfg(target_os = "windows")]
async fn native_input(
    tab: &Webview,
    action: AgentAction,
    prepared: PreparedAction,
) -> Result<(), String> {
    windows_driver::input(tab, action, prepared).await
}

#[cfg(target_os = "windows")]
async fn native_screenshot(tab: &Webview) -> Result<Value, String> {
    windows_driver::screenshot(tab).await
}

#[cfg(target_os = "linux")]
async fn native_input(
    tab: &Webview,
    action: AgentAction,
    prepared: PreparedAction,
) -> Result<(), String> {
    tokio::time::timeout(
        OPERATION_TIMEOUT,
        crate::browser::with_native(tab, move |native| linux::input(native, action, prepared)),
    )
    .await
    .map_err(|_| "Native browser input timed out".to_string())?
}

#[cfg(target_os = "linux")]
async fn native_screenshot(tab: &Webview) -> Result<Value, String> {
    linux::screenshot(tab).await
}

#[cfg(target_os = "macos")]
async fn native_input(
    tab: &Webview,
    action: AgentAction,
    prepared: PreparedAction,
) -> Result<(), String> {
    tokio::time::timeout(
        OPERATION_TIMEOUT,
        crate::browser::with_native(tab, move |native| macos::input(native, action, prepared)),
    )
    .await
    .map_err(|_| "Native browser input timed out".to_string())?
}

#[cfg(target_os = "macos")]
async fn native_screenshot(tab: &Webview) -> Result<Value, String> {
    macos::screenshot(tab).await
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use base64::Engine;
    use block2::RcBlock;
    use objc2::{msg_send, AnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType,
        NSImage,
    };
    use objc2_core_graphics::{CGEvent, CGEventField, CGEventType};
    use objc2_foundation::{NSDictionary, NSError, NSPoint, NSString};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use tauri::webview::PlatformWebview;

    fn point_in_window(view: &WKWebView, point: Point, viewport: Viewport) -> NSPoint {
        let bounds = view.bounds();
        let y = (point.y / viewport.height) * bounds.size.height;
        let local = NSPoint::new(
            (point.x / viewport.width) * bounds.size.width,
            if view.isFlipped() {
                y
            } else {
                bounds.size.height - y
            },
        );
        view.convertPoint_toView(local, None)
    }

    fn mouse_event(
        view: &WKWebView,
        point: NSPoint,
        kind: NSEventType,
    ) -> Result<objc2::rc::Retained<NSEvent>, String> {
        let window = view.window().ok_or("Browser window is unavailable")?;
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind, point, NSEventModifierFlags::empty(), 0.0, window.windowNumber(), None, 0, 1, 1.0,
        ).ok_or_else(|| "Could not construct a browser pointer event".into())
    }

    fn click(view: &WKWebView, point: NSPoint, button: MouseButton) -> Result<(), String> {
        match button {
            MouseButton::Left => {
                view.mouseDown(&*mouse_event(view, point, NSEventType::LeftMouseDown)?);
                view.mouseUp(&*mouse_event(view, point, NSEventType::LeftMouseUp)?);
            }
            MouseButton::Right => {
                view.rightMouseDown(&*mouse_event(view, point, NSEventType::RightMouseDown)?);
                view.rightMouseUp(&*mouse_event(view, point, NSEventType::RightMouseUp)?);
            }
        }
        Ok(())
    }

    fn key_parts(key: &str) -> Result<(String, u16, NSEventModifierFlags), String> {
        let mut parts = key.split('+').peekable();
        let mut flags = NSEventModifierFlags::empty();
        let mut name = "";
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                name = part;
                break;
            }
            flags |= match part.to_ascii_lowercase().as_str() {
                "meta" | "command" | "cmd" | "controlormeta" | "commandorcontrol" => {
                    NSEventModifierFlags::Command
                }
                "control" | "ctrl" => NSEventModifierFlags::Control,
                "shift" => NSEventModifierFlags::Shift,
                "alt" | "option" => NSEventModifierFlags::Option,
                _ => return Err(format!("Unsupported browser key modifier: {part}")),
            };
        }
        let (characters, code) = match name {
            "Enter" | "Return" => ("\r".into(), 36),
            "Tab" => ("\t".into(), 48),
            "Escape" | "Esc" => ("\u{1b}".into(), 53),
            "Backspace" => ("\u{7f}".into(), 51),
            "Delete" => ("\u{f728}".into(), 117),
            "ArrowLeft" => ("\u{f702}".into(), 123),
            "ArrowRight" => ("\u{f703}".into(), 124),
            "ArrowDown" => ("\u{f701}".into(), 125),
            "ArrowUp" => ("\u{f700}".into(), 126),
            "Home" => ("\u{f729}".into(), 115),
            "End" => ("\u{f72b}".into(), 119),
            "PageUp" => ("\u{f72c}".into(), 116),
            "PageDown" => ("\u{f72d}".into(), 121),
            "Space" => (" ".into(), 49),
            _ if name.chars().count() == 1 => {
                let code = match name.to_ascii_lowercase().as_str() {
                    "a" => 0,
                    "s" => 1,
                    "d" => 2,
                    "f" => 3,
                    "h" => 4,
                    "g" => 5,
                    "z" => 6,
                    "x" => 7,
                    "c" => 8,
                    "v" => 9,
                    "b" => 11,
                    "q" => 12,
                    "w" => 13,
                    "e" => 14,
                    "r" => 15,
                    "y" => 16,
                    "t" => 17,
                    "1" => 18,
                    "2" => 19,
                    "3" => 20,
                    "4" => 21,
                    "6" => 22,
                    "5" => 23,
                    "=" => 24,
                    "9" => 25,
                    "7" => 26,
                    "-" => 27,
                    "8" => 28,
                    "0" => 29,
                    "]" => 30,
                    "o" => 31,
                    "u" => 32,
                    "[" => 33,
                    "i" => 34,
                    "p" => 35,
                    "l" => 37,
                    "j" => 38,
                    "'" => 39,
                    "k" => 40,
                    ";" => 41,
                    "\\" => 42,
                    "," => 43,
                    "/" => 44,
                    "n" => 45,
                    "m" => 46,
                    "." => 47,
                    " " => 49,
                    "`" => 50,
                    _ => 0,
                };
                (
                    if flags.contains(NSEventModifierFlags::Shift) {
                        name.to_uppercase()
                    } else {
                        name.into()
                    },
                    code,
                )
            }
            _ => return Err(format!("Unsupported browser key: {name}")),
        };
        Ok((characters, code, flags))
    }

    fn key(view: &WKWebView, key: &str) -> Result<(), String> {
        let (characters, code, flags) = key_parts(key)?;
        let window = view.window().ok_or("Browser window is unavailable")?;
        let characters = NSString::from_str(&characters);
        for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
            let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                kind, NSPoint::new(0.0, 0.0), flags, 0.0, window.windowNumber(), None, &characters, &characters, false, code,
            ).ok_or("Could not construct a browser keyboard event")?;
            // WebKit may resend unhandled keys through NSApplication later. Keep those out of user input.
            crate::browser_focus_macos::tag_key_event(&event);
            // Dispatch only to this webview. NSApplication/NSWindow dispatch can invoke app menus.
            if kind == NSEventType::KeyDown {
                view.keyDown(&event);
            } else {
                view.keyUp(&event);
            }
        }
        Ok(())
    }

    pub(super) fn input(
        native: PlatformWebview,
        action: AgentAction,
        prepared: PreparedAction,
    ) -> Result<(), String> {
        // SAFETY: Tauri executes this closure on the UI thread with a live WKWebView.
        let view = unsafe { &*(native.inner() as *const WKWebView) };
        if view.isHiddenOrHasHiddenAncestor() {
            return Err("Activate the browser tab before controlling it".into());
        }
        let point = prepared
            .point
            .map(|point| point_in_window(view, point, prepared.viewport));
        match action {
            AgentAction::Click { button, .. } => click(
                view,
                point.ok_or("Click requires a target")?,
                button.unwrap_or(MouseButton::Left),
            ),
            AgentAction::Move { .. } => {
                view.mouseMoved(&*mouse_event(
                    view,
                    point.ok_or("Move requires a target")?,
                    NSEventType::MouseMoved,
                )?);
                Ok(())
            }
            AgentAction::Type { text, clear, .. } => {
                if clear.unwrap_or(false) {
                    // WKWebView implements the standard NSResponder editing commands.
                    unsafe {
                        let _: () = msg_send![view, selectAll: std::ptr::null::<objc2::runtime::AnyObject>()];
                    }
                }
                let text = NSString::from_str(&text);
                // Native text input supports Unicode without changing the user's clipboard.
                unsafe {
                    let _: () = msg_send![view, insertText: &*text];
                }
                Ok(())
            }
            AgentAction::Key { key: name } => key(view, &name),
            AgentAction::Scroll {
                delta_x, delta_y, ..
            } => {
                let point = point.unwrap_or_else(|| {
                    point_in_window(
                        view,
                        Point {
                            x: prepared.viewport.width / 2.0,
                            y: prepared.viewport.height / 2.0,
                        },
                        prepared.viewport,
                    )
                });
                let pointer = mouse_event(view, point, NSEventType::MouseMoved)?;
                let event = pointer
                    .CGEvent()
                    .ok_or("Could not create a browser scroll event")?;
                CGEvent::set_type(Some(&event), CGEventType::ScrollWheel);
                CGEvent::set_integer_value_field(
                    Some(&event),
                    CGEventField::ScrollWheelEventIsContinuous,
                    1,
                );
                for (field, value) in [
                    (CGEventField::ScrollWheelEventPointDeltaAxis1, -delta_y),
                    (
                        CGEventField::ScrollWheelEventPointDeltaAxis2,
                        -delta_x.unwrap_or(0.0),
                    ),
                    (CGEventField::ScrollWheelEventDeltaAxis1, -delta_y),
                    (
                        CGEventField::ScrollWheelEventDeltaAxis2,
                        -delta_x.unwrap_or(0.0),
                    ),
                ] {
                    CGEvent::set_double_value_field(Some(&event), field, value);
                }
                let event = NSEvent::eventWithCGEvent(&event)
                    .ok_or("Could not create a browser scroll event")?;
                view.scrollWheel(&event);
                Ok(())
            }
        }
    }

    pub(super) async fn screenshot(tab: &Webview) -> Result<Value, String> {
        let (send, receive) = tokio::sync::oneshot::channel();
        let send = Arc::new(Mutex::new(Some(send)));
        tab.with_webview(move |native| {
            let callback = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = (|| {
                    if let Some(error) = unsafe { error.as_ref() } { return Err(error.to_string()); }
                    let image = unsafe { image.as_ref() }.ok_or("Browser snapshot returned no image")?;
                    let tiff = image.TIFFRepresentation().ok_or("Could not encode the browser snapshot")?;
                    let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff).ok_or("Could not decode the browser snapshot")?;
                    // Empty properties has the expected NSDictionary key/value types.
                    let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }.ok_or("Could not encode a PNG browser snapshot")?;
                    Ok(json!({"data":base64::engine::general_purpose::STANDARD.encode(png.to_vec()),"mediaType":"image/png"}))
                })();
                if let Ok(mut send) = send.lock() { if let Some(send) = send.take() { let _ = send.send(result); } }
            });
            // SAFETY: Tauri supplies the WKWebView on its main thread; WebKit retains the callback.
            unsafe {
                let view = &*(native.inner() as *const WKWebView);
                let config = WKSnapshotConfiguration::new(MainThreadMarker::new_unchecked());
                view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &callback);
            }
        }).map_err(|error| error.to_string())?;
        tokio::time::timeout(OPERATION_TIMEOUT, receive)
            .await
            .map_err(|_| "Browser screenshot timed out".to_string())?
            .map_err(|error| error.to_string())?
    }
}

#[cfg(target_os = "windows")]
mod windows_driver {
    use super::*;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::{BOOL, HSTRING};

    /// WebView2 exposes CDP on the owned COM object; no remote-debugging port is opened.
    async fn cdp(tab: &Webview, method: &'static str, parameters: Value) -> Result<Value, String> {
        let (send, receive) = tokio::sync::oneshot::channel();
        let send = Arc::new(Mutex::new(Some(send)));
        let parameters = parameters.to_string();
        tab.with_webview(move |native| {
            let completion = send.clone();
            let result = (|| {
                // SAFETY: the controller and callback are used on their COM UI thread.
                unsafe {
                    let controller = native.controller();
                    let mut visible = BOOL::default();
                    controller
                        .IsVisible(&mut visible)
                        .map_err(|error| error.to_string())?;
                    if !visible.as_bool() {
                        return Err("Activate the browser tab before controlling it".to_string());
                    }
                    let view = controller
                        .CoreWebView2()
                        .map_err(|error| error.to_string())?;
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |status, response| {
                            let result = status.map_err(|error| error.to_string()).and_then(|()| {
                                serde_json::from_str::<Value>(&response)
                                    .map_err(|error| error.to_string())
                            });
                            if let Ok(mut send) = completion.lock() {
                                if let Some(send) = send.take() {
                                    let _ = send.send(result);
                                }
                            }
                            Ok(())
                        },
                    ));
                    view.CallDevToolsProtocolMethod(
                        &HSTRING::from(method),
                        &HSTRING::from(parameters),
                        &handler,
                    )
                    .map_err(|error| error.to_string())
                }
            })();
            if let Err(error) = result {
                if let Ok(mut send) = send.lock() {
                    if let Some(send) = send.take() {
                        let _ = send.send(Err(error));
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
        let value = tokio::time::timeout(OPERATION_TIMEOUT, receive)
            .await
            .map_err(|_| "Browser DevTools operation timed out".to_string())?
            .map_err(|error| error.to_string())??;
        if let Some(error) = value.get("error") {
            return Err(format!("Browser DevTools operation failed: {error}"));
        }
        Ok(value)
    }

    fn key_parameters(key: &str) -> Result<Value, String> {
        let mut parts = key.split('+').peekable();
        let mut modifiers = 0;
        let mut name = "";
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                name = part;
                break;
            }
            modifiers |= match part.to_ascii_lowercase().as_str() {
                "alt" | "option" => 1,
                "control" | "ctrl" | "controlormeta" | "commandorcontrol" => 2,
                "meta" | "command" | "cmd" => 4,
                "shift" => 8,
                _ => return Err(format!("Unsupported browser key modifier: {part}")),
            };
        }
        let (key, code, virtual_code) = match name {
            "Enter" | "Return" => ("Enter".into(), "Enter".into(), 13),
            "Tab" => ("Tab".into(), "Tab".into(), 9),
            "Escape" | "Esc" => ("Escape".into(), "Escape".into(), 27),
            "Backspace" => ("Backspace".into(), "Backspace".into(), 8),
            "Delete" => ("Delete".into(), "Delete".into(), 46),
            "ArrowLeft" => (name.into(), name.into(), 37),
            "ArrowUp" => (name.into(), name.into(), 38),
            "ArrowRight" => (name.into(), name.into(), 39),
            "ArrowDown" => (name.into(), name.into(), 40),
            "Home" => (name.into(), name.into(), 36),
            "End" => (name.into(), name.into(), 35),
            "PageUp" => (name.into(), name.into(), 33),
            "PageDown" => (name.into(), name.into(), 34),
            "Space" => (" ".into(), "Space".into(), 32),
            _ if name.chars().count() == 1 => {
                let character = name.chars().next().ok_or("Missing browser key")?;
                let code = if character.is_ascii_alphabetic() {
                    format!("Key{}", character.to_ascii_uppercase())
                } else if character.is_ascii_digit() {
                    format!("Digit{character}")
                } else {
                    String::new()
                };
                (
                    if modifiers & 8 != 0 {
                        name.to_uppercase()
                    } else {
                        name.into()
                    },
                    code,
                    character.to_ascii_uppercase() as u32,
                )
            }
            _ => return Err(format!("Unsupported browser key: {name}")),
        };
        Ok(
            json!({"key":key,"code":code,"windowsVirtualKeyCode":virtual_code,"modifiers":modifiers}),
        )
    }

    async fn key(tab: &Webview, name: &str) -> Result<(), String> {
        let mut parameters = key_parameters(name)?;
        parameters["type"] = json!("keyDown");
        let key = parameters["key"].as_str().unwrap_or_default();
        if parameters["modifiers"].as_u64().unwrap_or(0) & 7 == 0 {
            if key == "Enter" {
                parameters["text"] = json!("\r");
            } else if key.chars().count() == 1 {
                parameters["text"] = json!(key);
            }
        }
        cdp(tab, "Input.dispatchKeyEvent", parameters.clone()).await?;
        parameters["type"] = json!("keyUp");
        if let Some(object) = parameters.as_object_mut() {
            object.remove("text");
        }
        cdp(tab, "Input.dispatchKeyEvent", parameters).await?;
        Ok(())
    }

    pub(super) async fn input(
        tab: &Webview,
        action: AgentAction,
        prepared: PreparedAction,
    ) -> Result<(), String> {
        match action {
            AgentAction::Click { button, .. } => {
                let point = prepared.point.ok_or("Click requires a target")?;
                let button = match button.unwrap_or(MouseButton::Left) {
                    MouseButton::Left => "left",
                    MouseButton::Right => "right",
                };
                for kind in ["mousePressed", "mouseReleased"] {
                    cdp(
                        tab,
                        "Input.dispatchMouseEvent",
                        json!({"type":kind,"x":point.x,"y":point.y,"button":button,"clickCount":1}),
                    )
                    .await?;
                }
            }
            AgentAction::Move { .. } => {
                let point = prepared.point.ok_or("Move requires a target")?;
                cdp(
                    tab,
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseMoved","x":point.x,"y":point.y}),
                )
                .await?;
            }
            AgentAction::Type { text, clear, .. } => {
                if clear.unwrap_or(false) {
                    key(tab, "Control+a").await?;
                }
                cdp(tab, "Input.insertText", json!({"text":text})).await?;
            }
            AgentAction::Key { key: name } => key(tab, &name).await?,
            AgentAction::Scroll {
                delta_x, delta_y, ..
            } => {
                let point = prepared.point.unwrap_or(Point {
                    x: prepared.viewport.width / 2.0,
                    y: prepared.viewport.height / 2.0,
                });
                cdp(tab, "Input.dispatchMouseEvent", json!({"type":"mouseWheel","x":point.x,"y":point.y,"deltaX":delta_x.unwrap_or(0.0),"deltaY":delta_y})).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn screenshot(tab: &Webview) -> Result<Value, String> {
        let screenshot = cdp(
            tab,
            "Page.captureScreenshot",
            json!({"format":"png","fromSurface":true,"captureBeyondViewport":false}),
        )
        .await?;
        Ok(
            json!({"data":screenshot.get("data").and_then(Value::as_str).ok_or("Browser returned no screenshot")?,"mediaType":"image/png"}),
        )
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use base64::Engine;
    use gtk::{gdk, gio, glib::translate::*, prelude::*};
    use std::cell::RefCell;
    use tauri::webview::PlatformWebview;
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebView, WebViewExt};

    const AGENT_KEY_TIME: u32 = u32::MAX - 1;
    thread_local! {
        static KEY_GUARDS: RefCell<Vec<gtk::glib::WeakRef<WebView>>> = const { RefCell::new(Vec::new()) };
    }

    fn guard_key_replays(view: &WebView) -> Result<(), String> {
        KEY_GUARDS.with_borrow_mut(|guards| {
            guards.retain(|guard| guard.upgrade().is_some());
            if guards
                .iter()
                .any(|guard| guard.upgrade().as_ref() == Some(view))
            {
                return Ok(());
            }
            let toplevel = view.toplevel().ok_or("Browser window is unavailable")?;
            let target = view.downgrade();
            let handler = toplevel.connect_key_press_event(move |_, event| {
                if !event.is_send_event() || event.time() != AGENT_KEY_TIME {
                    return gtk::glib::Propagation::Proceed;
                }
                let Some(view) = target.upgrade() else {
                    return gtk::glib::Propagation::Proceed;
                };
                if event.window() != view.window() {
                    return gtk::glib::Propagation::Proceed;
                }
                // WebKit asynchronously replays unhandled keys through gtk_main_do_event.
                // Consume its replay flag on the original view before stopping the event,
                // so neither the user's focused widget nor app accelerators receive it.
                view.event(event);
                gtk::glib::Propagation::Stop
            });
            let toplevel = toplevel.downgrade();
            let handler = RefCell::new(Some(handler));
            view.connect_destroy(move |_| {
                if let (Some(toplevel), Some(handler)) = (toplevel.upgrade(), handler.take()) {
                    toplevel.disconnect(handler);
                }
            });
            guards.push(view.downgrade());
            Ok(())
        })
    }

    fn event(view: &WebView, kind: gdk::EventType, keyboard: bool) -> Result<gdk::Event, String> {
        let window = view.window().ok_or("Browser surface is unavailable")?;
        let mut event = gdk::Event::new(kind);
        // GdkEvent owns a reference to its target window, released by gdk_event_free.
        event.as_mut().window = window.to_glib_full();
        event.as_mut().send_event = 1;
        let seat = view
            .display()
            .default_seat()
            .ok_or("Browser input seat is unavailable")?;
        let device = if keyboard {
            seat.keyboard()
        } else {
            seat.pointer()
        };
        event.set_device(device.as_ref());
        Ok(event)
    }

    fn pointer(view: &WebView, point: Point, viewport: Viewport) -> Point {
        Point {
            x: point.x * f64::from(view.allocated_width()) / viewport.width,
            y: point.y * f64::from(view.allocated_height()) / viewport.height,
        }
    }

    fn dispatch(view: &WebView, event: &gdk::Event) {
        // Intentionally target the owned WebKit widget. Global GTK dispatch may run app accelerators.
        // WebKit's mouse handlers grab GTK focus themselves. Block that only during this
        // synchronous dispatch when another widget owns focus; never restore stale user focus later.
        let preserve_focus = view.can_focus() && !view.is_focus();
        if preserve_focus {
            view.set_can_focus(false);
        }
        view.event(event);
        if preserve_focus {
            view.set_can_focus(true);
        }
    }

    fn key(view: &WebView, name: &str) -> Result<(), String> {
        let mut parts = name.split('+').peekable();
        let mut state = gdk::ModifierType::empty();
        let mut name = "";
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                name = part;
                break;
            }
            state |= match part.to_ascii_lowercase().as_str() {
                "control" | "ctrl" | "controlormeta" | "commandorcontrol" => {
                    gdk::ModifierType::CONTROL_MASK
                }
                "meta" | "command" | "cmd" => gdk::ModifierType::META_MASK,
                "shift" => gdk::ModifierType::SHIFT_MASK,
                "alt" | "option" => gdk::ModifierType::MOD1_MASK,
                _ => return Err(format!("Unsupported browser key modifier: {part}")),
            };
        }
        let key_name = match name {
            "Enter" => "Return",
            "Esc" => "Escape",
            "Backspace" => "BackSpace",
            "ArrowLeft" => "Left",
            "ArrowRight" => "Right",
            "ArrowUp" => "Up",
            "ArrowDown" => "Down",
            "PageUp" => "Page_Up",
            "PageDown" => "Page_Down",
            "Space" => "space",
            other => other,
        };
        let keyval = if key_name.chars().count() == 1 {
            let character = key_name.chars().next().ok_or("Missing browser key")?;
            gdk::keys::Key::from_unicode(if state.contains(gdk::ModifierType::SHIFT_MASK) {
                character.to_ascii_uppercase()
            } else {
                character
            })
        } else {
            gdk::keys::Key::from_name(key_name)
        };
        let keyval: u32 = keyval.into_glib();
        if keyval == 0 || keyval == 0x00ff_ffff {
            return Err(format!("Unsupported browser key: {name}"));
        }
        let keymap = gdk::Keymap::for_display(&view.display())
            .ok_or("Browser keyboard map is unavailable")?;
        let physical = keymap.entries_for_keyval(keyval).into_iter().next();
        guard_key_replays(view)?;
        for kind in [gdk::EventType::KeyPress, gdk::EventType::KeyRelease] {
            let mut event = event(view, kind, true)?;
            let fields = event
                .downcast_mut::<gdk::EventKey>()
                .ok_or("Could not create keyboard event")?
                .as_mut();
            fields.time = AGENT_KEY_TIME;
            fields.keyval = keyval;
            fields.state = state.into_glib();
            if let Some(physical) = &physical {
                fields.hardware_keycode = physical.keycode() as u16;
                fields.group = physical.group() as u8;
            }
            dispatch(view, &event);
        }
        Ok(())
    }

    pub(super) fn input(
        native: PlatformWebview,
        action: AgentAction,
        prepared: PreparedAction,
    ) -> Result<(), String> {
        let view = native.inner();
        if !view.is_drawable() {
            return Err("Activate the browser tab before controlling it".into());
        }
        let point = prepared
            .point
            .map(|point| pointer(&view, point, prepared.viewport));
        match action {
            AgentAction::Click { button, .. } => {
                let point = point.ok_or("Click requires a target")?;
                let button = match button.unwrap_or(MouseButton::Left) {
                    MouseButton::Left => 1,
                    MouseButton::Right => 3,
                };
                for kind in [gdk::EventType::ButtonPress, gdk::EventType::ButtonRelease] {
                    let mut event = event(&view, kind, false)?;
                    let fields = event
                        .downcast_mut::<gdk::EventButton>()
                        .ok_or("Could not create pointer event")?
                        .as_mut();
                    fields.x = point.x;
                    fields.y = point.y;
                    fields.button = button;
                    dispatch(&view, &event);
                }
            }
            AgentAction::Move { .. } => {
                let point = point.ok_or("Move requires a target")?;
                let mut event = event(&view, gdk::EventType::MotionNotify, false)?;
                let fields = event
                    .downcast_mut::<gdk::EventMotion>()
                    .ok_or("Could not create pointer event")?
                    .as_mut();
                fields.x = point.x;
                fields.y = point.y;
                dispatch(&view, &event);
            }
            AgentAction::Type { text, clear, .. } => {
                if clear.unwrap_or(false) {
                    view.execute_editing_command("SelectAll");
                }
                view.execute_editing_command_with_argument("InsertText", &text);
            }
            AgentAction::Key { key: name } => {
                key(&view, &name)?;
            }
            AgentAction::Scroll {
                delta_x, delta_y, ..
            } => {
                let point = point.unwrap_or(Point {
                    x: f64::from(view.allocated_width()) / 2.0,
                    y: f64::from(view.allocated_height()) / 2.0,
                });
                let mut event = event(&view, gdk::EventType::Scroll, false)?;
                let precise = event
                    .source_device()
                    .is_some_and(|device| device.source() != gdk::InputSource::Mouse);
                // Invert WebKitGTK's Scrollbar::pixelsPerLineStep: mouse wheels scale
                // with the native viewport; precise touchpad deltas use a fixed 40px step.
                let step = |size: i32| {
                    if precise {
                        40.0
                    } else {
                        f64::from(size).powf(2.0 / 3.0).floor().max(1.0)
                    }
                };
                let fields = event
                    .downcast_mut::<gdk::EventScroll>()
                    .ok_or("Could not create scroll event")?
                    .as_mut();
                fields.x = point.x;
                fields.y = point.y;
                fields.direction = gdk::ScrollDirection::Smooth.into_glib();
                fields.delta_x = delta_x.unwrap_or(0.0) / step(view.allocated_width());
                fields.delta_y = delta_y / step(view.allocated_height());
                dispatch(&view, &event);
            }
        }
        Ok(())
    }

    pub(super) async fn screenshot(tab: &Webview) -> Result<Value, String> {
        let (send, receive) = tokio::sync::oneshot::channel();
        tab.with_webview(move |native| {
            native.inner().snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gio::Cancellable>, move |result| {
                let result = result.map_err(|error| error.to_string()).and_then(|surface| {
                    let mut png = Vec::new();
                    surface.write_to_png(&mut png).map_err(|error| error.to_string())?;
                    Ok(json!({"data":base64::engine::general_purpose::STANDARD.encode(png),"mediaType":"image/png"}))
                });
                let _ = send.send(result);
            });
        }).map_err(|error| error.to_string())?;
        tokio::time::timeout(OPERATION_TIMEOUT, receive)
            .await
            .map_err(|_| "Browser screenshot timed out".to_string())?
            .map_err(|error| error.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_targets_cannot_escape_or_ambiguously_combine_ref_and_coordinates() {
        for value in [
            json!({"type":"click","x":-1,"y":2}),
            json!({"type":"click","x":1}),
            json!({"type":"click","ref":"e1","x":1,"y":2}),
            json!({"type":"click"}),
        ] {
            assert!(validate_action(&serde_json::from_value(value).unwrap()).is_err());
        }
        assert!(validate_action(
            &serde_json::from_value(json!({"type":"click","ref":"doc:e1"})).unwrap()
        )
        .is_ok());
    }

    #[test]
    fn native_coordinates_are_validated_against_the_observed_viewport() {
        let viewport = Viewport {
            width: 600.0,
            height: 400.0,
        };
        for point in [
            Point { x: 600.0, y: 1.0 },
            Point { x: 0.0, y: 400.0 },
            Point {
                x: f64::NAN,
                y: 0.0,
            },
            Point { x: -1.0, y: 0.0 },
        ] {
            assert!(validate_prepared(&PreparedAction {
                point: Some(point),
                viewport
            })
            .is_err());
        }
        assert!(validate_prepared(&PreparedAction {
            point: Some(Point { x: 599.0, y: 399.0 }),
            viewport
        })
        .is_ok());
    }

    #[test]
    fn agent_commands_are_fixed_and_payloads_bounded() {
        assert!(
            serde_json::from_value::<AgentAction>(json!({"type":"eval","script":"alert(1)"}))
                .is_err()
        );
        assert!(serde_json::from_value::<AgentAction>(
            json!({"type":"click","ref":"e1","script":"alert(1)"})
        )
        .is_err());
        assert!(validate_action(&AgentAction::Type {
            text: "a".repeat(100_001),
            r#ref: None,
            clear: None
        })
        .is_err());
        assert!(validate_action(&AgentAction::Scroll {
            x: None,
            y: None,
            delta_x: None,
            delta_y: f64::INFINITY
        })
        .is_err());
    }

    #[test]
    fn screenshot_dimensions_report_image_pixels_for_retina_coordinate_mapping() {
        let screenshot = screenshot_dimensions(json!({
            "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e0AAAAASUVORK5CYII=",
            "mediaType": "image/png"
        }))
        .unwrap();
        assert_eq!(screenshot["width"], 1);
        assert_eq!(screenshot["height"], 1);
        assert!(screenshot_dimensions(json!({"data": "not a PNG"})).is_err());
    }
}
