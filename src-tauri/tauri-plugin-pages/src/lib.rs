/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Mobile page views have no Tauri bridge. Only the main app can issue these
//! commands, and evaluated scripts are fixed host observations, never agent code.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Emitter, Manager, Runtime, State, Webview,
};
use tokio::sync::Mutex;

#[cfg(mobile)]
use tauri::plugin::PluginHandle;
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pages);

const PAGE_DRIVER: &str = include_str!("../../../src/browser/page-driver.js");
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

struct Pages<R: Runtime> {
    #[cfg(mobile)]
    handle: PluginHandle<R>,
    #[cfg(not(mobile))]
    marker: std::marker::PhantomData<fn() -> R>,
    epoch: AtomicU64,
    operations: Mutex<()>,
}

impl<R: Runtime> Pages<R> {
    async fn native(&self, method: &str, args: Value) -> Result<Value, String> {
        #[cfg(mobile)]
        {
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                self.handle.run_mobile_plugin_async(method, args),
            )
            .await
            .map_err(|_| "Mobile page operation timed out".to_string())?
            .map_err(|error| error.to_string())
        }
        #[cfg(not(mobile))]
        {
            let _ = (method, args);
            Err("Mobile page adapter is unavailable on this platform".into())
        }
    }

    async fn call(&self, method: &str, mut args: Value) -> Result<Value, String> {
        let epoch = self.epoch.load(Ordering::SeqCst);
        // Hiding/closing a surface must never wait behind a stalled guest script.
        if matches!(method, "present" | "close") {
            args["epoch"] = json!(epoch);
            return self.native(method, args).await;
        }
        let _operation = self.operations.lock().await;
        if epoch != self.epoch.load(Ordering::SeqCst) {
            return Err("The main page navigated; this operation was cancelled".into());
        }
        args["epoch"] = json!(epoch);
        self.native(method, args).await
    }

    async fn evaluate(&self, label: String, expression: String) -> Result<Value, String> {
        let script = format!(
            "(()=>{{try{{{PAGE_DRIVER}\nreturn JSON.stringify({{ok:true,value:({expression})}});}}catch(error){{return JSON.stringify({{ok:false,error:String(error?.message ?? error)}});}}}})()"
        );
        let raw = self
            .call("evaluate", json!({"label":label,"script":script}))
            .await?;
        decode_observation(raw)
    }
}

fn decode_observation(raw: Value) -> Result<Value, String> {
    let raw = raw.as_str().ok_or("Mobile page returned no observation")?;
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err("Mobile page response exceeds the 2 MiB observation limit".into());
    }
    let result: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Page observation failed")
            .chars()
            .take(2000)
            .collect());
    }
    Ok(result.get("value").cloned().unwrap_or(Value::Null))
}

fn authorize<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("Page commands are restricted to the main app webview".into());
    }
    Ok(())
}

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 128
        && (label.starts_with("page-") || label.starts_with("sidebar-webview-"))
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn target<R: Runtime>(webview: &Webview<R>, label: &str) -> Result<(), String> {
    authorize(webview)?;
    if !valid_label(label) {
        return Err("Invalid page label".into());
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), String> {
    if url == "about:blank" {
        return Ok(());
    }
    if url.len() > 8192 {
        return Err("Page address is too long".into());
    }
    let url = tauri::Url::parse(url).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Page navigation requires an HTTP or HTTPS URL".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    clip: Option<Insets>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Insets {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

impl Bounds {
    fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|n| !n.is_finite() || n.abs() > 100_000.0)
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err("Page bounds must be finite with positive dimensions".into());
        }
        if let Some(clip) = &self.clip {
            if [clip.top, clip.right, clip.bottom, clip.left]
                .iter()
                .any(|n| !n.is_finite() || *n < 0.0)
                || clip.left + clip.right > self.width
                || clip.top + clip.bottom > self.height
            {
                return Err("Page clipping must stay within its viewport".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum NavigationAction {
    Back,
    Forward,
    Reload,
    Stop,
}

#[tauri::command]
async fn capabilities<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
) -> Result<Value, String> {
    authorize(&webview)?;
    pages.call("capabilities", json!({})).await
}

#[tauri::command]
async fn create<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
    url: String,
    bounds: Bounds,
    hidden: bool,
) -> Result<Value, String> {
    target(&webview, &label)?;
    validate_url(&url)?;
    bounds.validate()?;
    pages
        .call(
            "create",
            json!({"label":label,"url":url,"bounds":bounds,"hidden":hidden}),
        )
        .await
}

#[tauri::command]
async fn present<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
    bounds: Bounds,
    visible: bool,
) -> Result<Value, String> {
    target(&webview, &label)?;
    bounds.validate()?;
    pages
        .call(
            "present",
            json!({"label":label,"bounds":bounds,"visible":visible}),
        )
        .await
}

#[tauri::command]
async fn navigate<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
    url: String,
) -> Result<Value, String> {
    target(&webview, &label)?;
    validate_url(&url)?;
    pages
        .call("navigate", json!({"label":label,"url":url}))
        .await
}

#[tauri::command]
async fn action<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
    action: NavigationAction,
) -> Result<Value, String> {
    target(&webview, &label)?;
    pages
        .call("action", json!({"label":label,"action":action}))
        .await
}

#[tauri::command]
async fn state<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
) -> Result<Value, String> {
    target(&webview, &label)?;
    let mut state = pages.call("state", json!({"label":label})).await?;
    if let Some(popups) = state
        .as_object_mut()
        .and_then(|state| state.remove("newTabUrls"))
    {
        if let Some(urls) = popups.as_array() {
            for url in urls.iter().take(8).filter_map(Value::as_str) {
                if validate_url(url).is_ok() && url != "about:blank" {
                    webview
                        .app_handle()
                        .emit_to("main", "browser-new-tab", json!({"label":label,"url":url}))
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    }
    Ok(state)
}

#[tauri::command]
async fn close<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
) -> Result<Value, String> {
    target(&webview, &label)?;
    pages.call("close", json!({"label":label})).await
}

#[tauri::command]
async fn snapshot<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
) -> Result<Value, String> {
    target(&webview, &label)?;
    let mut snapshot = pages
        .evaluate(label, "window.__thunderboltBrowserDriver.snapshot()".into())
        .await?;
    let object = snapshot
        .as_object_mut()
        .ok_or("Page snapshot must be an object")?;
    object.insert(
        "capabilities".into(),
        json!({"nativeInput":false,"screenshot":false}),
    );
    // This adapter cannot offer screenshot/coordinate fallbacks for nested frames.
    if object
        .get("warnings")
        .and_then(Value::as_array)
        .is_some_and(|warnings| !warnings.is_empty())
    {
        object.insert(
            "warnings".into(),
            json!(["Frame contents are not included in page observations."]),
        );
    }
    Ok(snapshot)
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 200 {
        return Err("A valid picker request ID is required".into());
    }
    Ok(())
}

#[tauri::command]
async fn set_picker<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
    enabled: bool,
    request_id: String,
) -> Result<Value, String> {
    target(&webview, &label)?;
    validate_request_id(&request_id)?;
    pages
        .evaluate(
            label,
            format!(
                "window.__thunderboltBrowserDriver.setPicker({enabled},{})",
                serde_json::to_string(&request_id).map_err(|error| error.to_string())?
            ),
        )
        .await
}

#[tauri::command]
async fn poll_picker<R: Runtime>(
    webview: Webview<R>,
    pages: State<'_, Pages<R>>,
    label: String,
    request_id: String,
) -> Result<Value, String> {
    target(&webview, &label)?;
    validate_request_id(&request_id)?;
    pages
        .evaluate(
            label,
            format!(
                "window.__thunderboltBrowserDriver.takePick({})",
                serde_json::to_string(&request_id).map_err(|error| error.to_string())?
            ),
        )
        .await
}

/// Registers mobile page commands while keeping untrusted page views bridge-free.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pages")
        .invoke_handler(tauri::generate_handler![
            capabilities,
            create,
            present,
            navigate,
            action,
            state,
            close,
            snapshot,
            set_picker,
            poll_picker
        ])
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            let handle = _api.register_ios_plugin(init_plugin_pages)?;
            #[cfg(target_os = "android")]
            let handle =
                _api.register_android_plugin("net.thunderbird.thunderbolt.pages", "PagesPlugin")?;
            app.manage(Pages::<R> {
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                marker: std::marker::PhantomData,
                epoch: AtomicU64::new(0),
                operations: Mutex::new(()),
            });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() != "main"
                || payload.event() != tauri::webview::PageLoadEvent::Started
            {
                return;
            }
            let Some(pages) = webview.try_state::<Pages<R>>() else {
                return;
            };
            let epoch = pages.epoch.fetch_add(1, Ordering::SeqCst) + 1;
            #[cfg(mobile)]
            {
                let app = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let pages = app.state::<Pages<R>>();
                    if let Err(error) = pages.native("reset", json!({"epoch":epoch})).await {
                        eprintln!("Could not release old mobile pages: {error}");
                    }
                });
            }
            #[cfg(not(mobile))]
            let _ = epoch;
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_navigation_excludes_native_and_executable_urls() {
        for url in [
            "about:blank",
            "https://example.com",
            "http://127.0.0.1:4000/",
        ] {
            assert!(validate_url(url).is_ok());
        }
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "tauri://localhost",
            "https://",
        ] {
            assert!(validate_url(url).is_err());
        }
    }

    #[test]
    fn labels_cannot_address_the_host_or_escape_a_page_namespace() {
        assert!(valid_label("page-one"));
        assert!(valid_label("sidebar-webview-123"));
        for label in ["main", "", "page-../main", "page-;alert(1)"] {
            assert!(!valid_label(label));
        }
    }

    #[test]
    fn observations_are_bounded_and_failures_are_not_successes() {
        assert_eq!(
            decode_observation(json!("{\"ok\":true,\"value\":{\"title\":\"Page\"}}")),
            Ok(json!({"title":"Page"}))
        );
        assert!(decode_observation(json!("{\"ok\":false,\"error\":\"No document\"}")).is_err());
        assert!(decode_observation(json!("x".repeat(MAX_RESPONSE_BYTES + 1))).is_err());
        assert!(decode_observation(json!({"ok":true})).is_err());
    }

    #[test]
    fn bounds_reject_nonfinite_or_extreme_values() {
        assert!(Bounds {
            x: 0.0,
            y: 40.0,
            width: 300.0,
            height: 500.0,
            clip: None
        }
        .validate()
        .is_ok());
        assert!(Bounds {
            x: f64::NAN,
            y: 0.0,
            width: 300.0,
            height: 500.0,
            clip: None
        }
        .validate()
        .is_err());
        assert!(Bounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 500.0,
            clip: None
        }
        .validate()
        .is_err());
    }
}
