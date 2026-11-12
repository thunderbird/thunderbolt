/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{
    NewWindowResponse, PageLoadEvent, PermissionResponse, PlatformWebview, WebviewBuilder,
};
use tauri::{
    Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl,
};

#[derive(Default)]
pub struct BrowserRegistry {
    entries: Mutex<HashMap<String, Arc<Mutex<BrowserMetadata>>>>,
    creation: tokio::sync::Mutex<()>,
    document_generation: AtomicU64,
    profile_cleanup: crate::browser_profile::PendingCleanup,
}

#[derive(Default)]
struct BrowserMetadata {
    document_generation: u64,
    url: String,
    title: String,
    is_loading: bool,
    control_lock: Arc<tokio::sync::Mutex<()>>,
    operations: Arc<crate::browser_operation::BrowserOperations>,
}

impl BrowserMetadata {
    fn page_loaded(&mut self, url: &Url, event: PageLoadEvent) {
        self.url = url.to_string();
        self.is_loading = matches!(event, PageLoadEvent::Started);
        if self.is_loading {
            // Prepared coordinates and element references belong to the previous document.
            self.operations.cancel_all();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    url: String,
    title: String,
    favicon_urls: Vec<String>,
    is_loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Clone, Serialize)]
struct BrowserNewTab {
    label: String,
    url: String,
}

#[derive(Clone, Copy, Deserialize)]
pub struct BrowserBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl BrowserBounds {
    pub(crate) fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserAction {
    Back,
    Forward,
    Reload,
    Stop,
}

fn allowed_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

fn parse_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|error| error.to_string())?;
    if !allowed_url(&parsed) {
        return Err("Browser navigation requires an HTTP or HTTPS URL".into());
    }
    Ok(parsed)
}

fn allowed_navigation(url: &Url) -> bool {
    url.as_str() == "about:blank" || allowed_url(url)
}

fn parse_initial_url(url: &str) -> Result<Url, String> {
    if url == "about:blank" {
        return Url::parse(url).map_err(|error| error.to_string());
    }
    parse_url(url)
}

fn authorized_labels(caller: &str, window: &str, label: &str) -> bool {
    caller == "main"
        && window == "main"
        && label
            .strip_prefix("sidebar-webview-")
            .is_some_and(|suffix| !suffix.is_empty())
        && label
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub(crate) fn authorize(caller: &Webview, label: &str) -> Result<(), String> {
    if !authorized_labels(caller.label(), caller.window().label(), label) {
        return Err("Browser commands are restricted to the main app webview".into());
    }
    Ok(())
}

pub(crate) fn browser(caller: &Webview, label: &str) -> Result<Webview, String> {
    authorize(caller, label)?;
    caller
        .get_webview(label)
        .filter(|webview| webview.window().label() == "main")
        .ok_or_else(|| "Browser webview is closed".into())
}

/// A tab's action queue is owned by its registry entry and disappears when it closes.
pub(crate) fn control_lock(
    registry: &BrowserRegistry,
    label: &str,
) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    Ok(metadata(registry, label)?
        .lock()
        .map_err(|error| error.to_string())?
        .control_lock
        .clone())
}

pub(crate) fn operations(
    registry: &BrowserRegistry,
    label: &str,
) -> Result<Arc<crate::browser_operation::BrowserOperations>, String> {
    Ok(metadata(registry, label)?
        .lock()
        .map_err(|error| error.to_string())?
        .operations
        .clone())
}

fn metadata(
    registry: &BrowserRegistry,
    label: &str,
) -> Result<Arc<Mutex<BrowserMetadata>>, String> {
    registry
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .get(label)
        .cloned()
        .ok_or_else(|| "Browser webview is closed".into())
}

/// Native children outlive a renderer reload; destroy the old document's tabs and input tickets.
pub(crate) fn main_page_started(webview: &Webview) {
    let registry = webview.state::<BrowserRegistry>();
    let generation = registry.document_generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(entries) = registry.entries.lock() {
        for entry in entries.values() {
            if let Ok(entry) = entry.lock() {
                entry.operations.cancel_all();
            }
        }
    }
    let caller = webview.clone();
    tauri::async_runtime::spawn(async move {
        let registry = caller.state::<BrowserRegistry>();
        let _creation = registry.creation.lock().await;
        let result = async {
            let labels = stale_labels(&registry, generation)?;
            for label in labels {
                if let Some(tab) = caller.get_webview(&label) {
                    #[cfg(target_os = "macos")]
                    crate::browser_presentation::before_close(&tab).await?;
                    tab.close().map_err(|error| error.to_string())?;
                }
                registry
                    .entries
                    .lock()
                    .map_err(|error| error.to_string())?
                    .remove(&label);
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("Could not close browser tabs after renderer navigation: {error}");
        }
    });
}

fn stale_labels(registry: &BrowserRegistry, generation: u64) -> Result<Vec<String>, String> {
    registry
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .filter_map(|(label, entry)| match entry.lock() {
            Ok(entry) => (entry.document_generation < generation).then(|| Ok(label.clone())),
            Err(error) => Some(Err(error.to_string())),
        })
        .collect()
}

/// Creates the browser in native code so remote pages cannot opt out of navigation policy.
#[tauri::command]
pub async fn browser_create(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
    url: String,
    bounds: BrowserBounds,
    hidden: bool,
) -> Result<(), String> {
    authorize(&webview, &label)?;
    let url = parse_initial_url(&url)?;
    if !bounds.is_valid() {
        return Err("Browser bounds must be finite with a positive size".into());
    }
    // Concurrent first tabs must share the first completed tab's browser profile.
    let generation = registry.document_generation.load(Ordering::SeqCst);
    let _creation = registry.creation.lock().await;
    if registry.document_generation.load(Ordering::SeqCst) != generation {
        return Err("The main page navigated before the tab could open".into());
    }
    let cleanup_marker = crate::browser_profile::cleanup_marker(&webview)?;
    if registry.profile_cleanup.required(&cleanup_marker)? {
        clear_profile(&webview, &registry, &cleanup_marker).await?;
    }
    let metadata = Arc::new(Mutex::new(BrowserMetadata {
        document_generation: generation,
        url: url.to_string(),
        title: String::new(),
        is_loading: true,
        ..Default::default()
    }));
    {
        let mut entries = registry.entries.lock().map_err(|error| error.to_string())?;
        if entries.contains_key(&label) || webview.get_webview(&label).is_some() {
            return Err("Browser webview already exists".into());
        }
        entries.insert(label.clone(), metadata.clone());
    }
    let load_metadata = metadata.clone();
    let popup_app = webview.app_handle().clone();
    let popup_label = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .disable_native_api()
        .focused(false)
        .on_navigation(allowed_navigation)
        .on_permission_request(|_, _| PermissionResponse::Default)
        .on_page_load(move |_, payload| {
            if let Ok(mut state) = load_metadata.lock() {
                state.page_loaded(payload.url(), payload.event());
            }
        })
        .on_document_title_changed(move |_, title| {
            if let Ok(mut state) = metadata.lock() {
                state.title = title;
            }
        })
        .on_new_window(move |url, _| {
            // The trusted app creates a managed tab; remote pages never receive new IPC access.
            if allowed_url(&url) && popup_app.get_webview(&popup_label).is_some() {
                let app = popup_app.clone();
                let label = popup_label.clone();
                // Allow WebKit to finish rejecting the unmanaged window before creating its tab.
                tauri::async_runtime::spawn(async move {
                    if app.get_webview(&label).is_none() {
                        return;
                    }
                    if let Err(error) = app.emit_to(
                        EventTarget::webview("main"),
                        "browser-new-tab",
                        BrowserNewTab {
                            label,
                            url: url.into(),
                        },
                    ) {
                        eprintln!("Could not open browser tab: {error}");
                    }
                });
            }
            NewWindowResponse::Deny
        });
    let existing = registry
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .keys()
        .filter(|candidate| *candidate != &label)
        .find_map(|label| webview.get_webview(label));
    let result = create_browser(&webview, builder, existing, bounds).await;
    match result {
        Ok(browser) => {
            let initialized: Result<(), String> = async {
                #[cfg(target_os = "macos")]
                crate::browser_focus_macos::protect_tab(&browser).await?;
                if hidden {
                    browser.hide().map_err(|error| error.to_string())?;
                }
                if let Err(error) = crate::browser_resize::raise(&webview).await {
                    eprintln!("Could not raise browser resize grip: {error}");
                }
                Ok(())
            }
            .await;
            if let Err(error) = initialized {
                let _ = browser.close();
                registry
                    .entries
                    .lock()
                    .map_err(|error| error.to_string())?
                    .remove(&label);
                return Err(error);
            }
            Ok(())
        }
        Err(error) => {
            registry
                .entries
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&label);
            Err(error)
        }
    }
}

/// Shares the isolated browser profile while keeping every tab's page and history independent.
async fn create_browser(
    caller: &Webview,
    builder: WebviewBuilder<tauri::Wry>,
    existing: Option<Webview>,
    bounds: BrowserBounds,
) -> Result<Webview, String> {
    let builder = crate::browser_profile::configure(caller, builder)?;
    let builder = match existing {
        Some(existing) => {
            with_native(&existing, move |native| shared_session(builder, native)).await?
        }
        None => builder,
    };
    caller
        .window()
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn shared_session(
    builder: WebviewBuilder<tauri::Wry>,
    native: PlatformWebview,
) -> Result<WebviewBuilder<tauri::Wry>, String> {
    let main_thread =
        objc2::MainThreadMarker::new().ok_or("Browser configuration requires the UI thread")?;
    // SAFETY: with_native supplies a live WKWebView and runs this on its UI thread.
    unsafe {
        let view = &*(native.inner() as *const objc2_web_kit::WKWebView);
        let config = objc2_web_kit::WKWebViewConfiguration::new(main_thread);
        config.setWebsiteDataStore(&view.configuration().websiteDataStore());
        Ok(builder.with_webview_configuration(config))
    }
}

#[cfg(target_os = "linux")]
fn shared_session(
    builder: WebviewBuilder<tauri::Wry>,
    native: PlatformWebview,
) -> Result<WebviewBuilder<tauri::Wry>, String> {
    Ok(builder.with_related_view(native.inner()))
}

#[cfg(target_os = "windows")]
fn shared_session(
    builder: WebviewBuilder<tauri::Wry>,
    native: PlatformWebview,
) -> Result<WebviewBuilder<tauri::Wry>, String> {
    Ok(builder.with_environment(native.environment()))
}

#[tauri::command]
pub async fn browser_navigate(webview: Webview, label: String, url: String) -> Result<(), String> {
    let url = parse_url(&url)?;
    let browser = browser(&webview, &label)?;
    #[cfg(target_os = "macos")]
    crate::browser_focus_macos::protect_tab(&browser).await?;
    with_native(&browser, move |native| native_navigate(native, url)).await
}

/// Execute platform operations on the native UI thread without blocking the async command.
pub(crate) async fn with_native<T: Send + 'static>(
    webview: &Webview,
    operation: impl FnOnce(PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |native| {
            let _ = send.send(operation(native));
        })
        .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn browser_action(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
    action: BrowserAction,
) -> Result<(), String> {
    let browser = browser(&webview, &label)?;
    #[cfg(target_os = "macos")]
    crate::browser_focus_macos::protect_tab(&browser).await?;
    with_native(&browser, move |native| native_action(native, action)).await?;
    if matches!(action, BrowserAction::Stop) {
        metadata(&registry, &label)?
            .lock()
            .map_err(|error| error.to_string())?
            .is_loading = false;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_get_state(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
) -> Result<BrowserState, String> {
    let browser = browser(&webview, &label)?;
    let url = browser_url(&browser).await?;
    let (can_go_back, can_go_forward, native_loading) = with_native(&browser, native_state).await?;
    let favicon_urls = match url.as_deref() {
        Some(url) if url.starts_with("https://") || url.starts_with("http://") => {
            read_favicons(&browser, url).await
        }
        _ => Vec::new(),
    };
    let metadata = metadata(&registry, &label)?;
    let metadata = metadata.lock().map_err(|error| error.to_string())?;
    Ok(BrowserState {
        url: url.unwrap_or_else(|| metadata.url.clone()),
        title: metadata.title.clone(),
        favicon_urls,
        is_loading: native_loading.unwrap_or(metadata.is_loading),
        can_go_back,
        can_go_forward,
    })
}

/// Read declared icons across all three engines without installing remote IPC or fetching page HTML again.
async fn read_favicons(browser: &Webview, expected_url: &str) -> Vec<String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let send = Mutex::new(Some(send));
    if browser
        .eval_with_callback(
            include_str!("../../src/browser/favicon-reader.js"),
            move |result| {
                if let Ok(mut send) = send.lock() {
                    if let Some(send) = send.take() {
                        let _ = send.send(result);
                    }
                }
            },
        )
        .is_err()
    {
        return Vec::new();
    }
    // A document may be replacing itself during navigation. Icons must not block normal browser state.
    let Ok(Ok(raw)) = tokio::time::timeout(std::time::Duration::from_millis(500), receive).await
    else {
        return Vec::new();
    };
    favicon_urls_from_response(&raw, expected_url)
}

fn favicon_urls_from_response(raw: &str, expected_url: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct Icons {
        url: String,
        icons: Vec<String>,
    }
    if raw.len() > 80 * 1024 {
        return Vec::new();
    }
    let Ok(icons) = serde_json::from_str::<Icons>(raw) else {
        return Vec::new();
    };
    if icons.url != expected_url {
        return Vec::new();
    }
    icons
        .icons
        .into_iter()
        .take(8)
        .filter(|icon| {
            icon.len() <= 8192
                && Url::parse(icon).is_ok_and(|url| {
                    allowed_url(&url) && url.username().is_empty() && url.password().is_none()
                })
        })
        .collect()
}

#[cfg(target_os = "macos")]
async fn browser_url(browser: &Webview) -> Result<Option<String>, String> {
    with_native(browser, |native| {
        // SAFETY: Tauri supplies a live WKWebView and runs this on its UI thread.
        // WKWebView.URL is nil before its first navigation commits, including new blank tabs.
        // Wry's portable url() unwraps it, which would panic on the application's UI thread.
        let view = unsafe { &*(native.inner() as *const objc2_web_kit::WKWebView) };
        Ok(unsafe { view.URL() }
            .and_then(|url| url.absoluteString())
            .map(|url| url.to_string()))
    })
    .await
}

#[cfg(not(target_os = "macos"))]
async fn browser_url(browser: &Webview) -> Result<Option<String>, String> {
    browser
        .url()
        .map(|url| Some(url.to_string()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_close(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
    label: String,
) -> Result<(), String> {
    authorize(&webview, &label)?;
    if let Ok(operations) = operations(&registry, &label) {
        operations.cancel_all();
    }
    // Do not close a session's last owner while another tab is adopting its native context.
    let _creation = registry.creation.lock().await;
    if let Some(browser) = webview.get_webview(&label) {
        #[cfg(target_os = "macos")]
        crate::browser_presentation::before_close(&browser).await?;
        browser.close().map_err(|error| error.to_string())?;
    }
    registry
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&label);
    Ok(())
}

/// Remove website credentials at an identity boundary, including when no tab is open.
#[tauri::command]
pub async fn browser_clear_profile(
    webview: Webview,
    registry: State<'_, BrowserRegistry>,
) -> Result<(), String> {
    authorize(&webview, "sidebar-webview-profile-cleanup")?;
    // Reject tab creation already queued by the identity that is leaving.
    registry.document_generation.fetch_add(1, Ordering::SeqCst);
    let _creation = registry.creation.lock().await;
    let marker = crate::browser_profile::cleanup_marker(&webview)?;
    clear_profile(&webview, &registry, &marker).await
}

/// Called with the creation lock held so no website can repopulate a cleared profile.
async fn clear_profile(
    caller: &Webview,
    registry: &BrowserRegistry,
    marker: &std::path::Path,
) -> Result<(), String> {
    registry.profile_cleanup.begin(marker)?;
    let labels: Vec<_> = registry
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .keys()
        .cloned()
        .collect();
    let existing = labels.iter().find_map(|label| caller.get_webview(label));
    static NEXT_CLEANUP_ID: AtomicU64 = AtomicU64::new(0);
    let label = format!(
        "sidebar-webview-profile-cleanup-{}",
        NEXT_CLEANUP_ID.fetch_add(1, Ordering::Relaxed)
    );
    let builder = WebviewBuilder::new(
        &label,
        WebviewUrl::External(Url::parse("about:blank").unwrap()),
    )
    .disable_native_api()
    .focused(false)
    .on_navigation(|url| url.as_str() == "about:blank")
    .on_new_window(|_, _| NewWindowResponse::Deny);
    // Keep ownership of the exact profile while all documents are closed. This
    // also preserves the shared private profile on macOS versions before 14.
    let maintenance = create_browser(
        caller,
        builder,
        existing,
        BrowserBounds {
            x: -10.0,
            y: -10.0,
            width: 1.0,
            height: 1.0,
        },
    )
    .await?;
    let cleared = async {
        maintenance.hide().map_err(|error| error.to_string())?;
        for label in labels {
            operations(registry, &label)?.cancel_all();
            if let Some(tab) = caller.get_webview(&label) {
                #[cfg(target_os = "macos")]
                crate::browser_presentation::before_close(&tab).await?;
                tab.close().map_err(|error| error.to_string())?;
            }
            registry
                .entries
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&label);
        }
        let (completed, completion) = tokio::sync::oneshot::channel();
        with_native(&maintenance, move |native| {
            crate::browser_profile_clear::clear(native, completed)
        })
        .await?;
        completion.await.map_err(|error| error.to_string())?
    }
    .await;
    let closed = maintenance.close().map_err(|error| error.to_string());
    cleared?;
    closed?;
    registry.profile_cleanup.finish(marker)
}

#[cfg(target_os = "macos")]
fn native_navigate(native: PlatformWebview, url: Url) -> Result<(), String> {
    use objc2_foundation::{NSString, NSURLRequest, NSURL};
    // SAFETY: Tauri supplies the live WKWebView on its UI thread.
    let view = unsafe { &*(native.inner() as *const objc2_web_kit::WKWebView) };
    let url =
        NSURL::URLWithString(&NSString::from_str(url.as_str())).ok_or("Invalid browser address")?;
    unsafe { view.loadRequest(&NSURLRequest::requestWithURL(&url)) };
    Ok(())
}

#[cfg(target_os = "linux")]
fn native_navigate(native: PlatformWebview, url: Url) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    native.inner().load_uri(url.as_str());
    Ok(())
}

#[cfg(target_os = "windows")]
fn native_navigate(native: PlatformWebview, url: Url) -> Result<(), String> {
    // SAFETY: the COM controller belongs to the UI thread supplied by with_webview.
    unsafe {
        native
            .controller()
            .CoreWebView2()
            .and_then(|view| view.Navigate(&windows::core::HSTRING::from(url.as_str())))
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
fn native_state(native: PlatformWebview) -> Result<(bool, bool, Option<bool>), String> {
    // SAFETY: Tauri supplies a live WKWebView and executes with_webview on its UI thread.
    let view = unsafe { &*(native.inner() as *const objc2_web_kit::WKWebView) };
    Ok(unsafe {
        (
            view.canGoBack(),
            view.canGoForward(),
            Some(view.isLoading()),
        )
    })
}

#[cfg(target_os = "macos")]
fn native_action(native: PlatformWebview, action: BrowserAction) -> Result<(), String> {
    // SAFETY: Tauri supplies a live WKWebView and executes with_webview on its UI thread.
    let view = unsafe { &*(native.inner() as *const objc2_web_kit::WKWebView) };
    unsafe {
        match action {
            BrowserAction::Back => {
                view.goBack();
            }
            BrowserAction::Forward => {
                view.goForward();
            }
            BrowserAction::Stop => view.stopLoading(),
            BrowserAction::Reload => {
                view.reload();
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn native_state(native: PlatformWebview) -> Result<(bool, bool, Option<bool>), String> {
    use webkit2gtk::WebViewExt;
    let view = native.inner();
    Ok((
        view.can_go_back(),
        view.can_go_forward(),
        Some(view.is_loading()),
    ))
}

#[cfg(target_os = "linux")]
fn native_action(native: PlatformWebview, action: BrowserAction) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    let view = native.inner();
    match action {
        BrowserAction::Back => view.go_back(),
        BrowserAction::Forward => view.go_forward(),
        BrowserAction::Stop => view.stop_loading(),
        BrowserAction::Reload => view.reload(),
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn native_state(native: PlatformWebview) -> Result<(bool, bool, Option<bool>), String> {
    // SAFETY: the COM controller belongs to the UI thread supplied by with_webview.
    unsafe {
        let view = native
            .controller()
            .CoreWebView2()
            .map_err(|error| error.to_string())?;
        let mut back = Default::default();
        let mut forward = Default::default();
        view.CanGoBack(&mut back)
            .map_err(|error| error.to_string())?;
        view.CanGoForward(&mut forward)
            .map_err(|error| error.to_string())?;
        Ok((back.as_bool(), forward.as_bool(), None))
    }
}

#[cfg(target_os = "windows")]
fn native_action(native: PlatformWebview, action: BrowserAction) -> Result<(), String> {
    // SAFETY: the COM controller belongs to the UI thread supplied by with_webview.
    unsafe {
        let view = native
            .controller()
            .CoreWebView2()
            .map_err(|error| error.to_string())?;
        match action {
            BrowserAction::Back => view.GoBack(),
            BrowserAction::Forward => view.GoForward(),
            BrowserAction::Stop => view.Stop(),
            BrowserAction::Reload => view.Reload(),
        }
        .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_navigation_revokes_prepared_input_but_load_completion_does_not() {
        let mut metadata = BrowserMetadata::default();
        let prior = metadata
            .operations
            .enter(metadata.operations.begin())
            .unwrap();
        let url = Url::parse("https://example.com/next").unwrap();
        metadata.page_loaded(&url, PageLoadEvent::Started);
        assert!(prior.permit().check().is_err());
        assert!(metadata.is_loading);
        assert_eq!(metadata.url, url.as_str());
        let current = metadata
            .operations
            .enter(metadata.operations.begin())
            .unwrap();
        metadata.page_loaded(&url, PageLoadEvent::Finished);
        assert!(current.permit().check().is_ok());
        assert!(!metadata.is_loading);
    }

    #[test]
    fn delayed_reload_cleanup_preserves_tabs_from_the_new_document() {
        let registry = BrowserRegistry::default();
        for (label, document_generation) in [("old", 1), ("new", 2), ("newer", 3)] {
            registry.entries.lock().unwrap().insert(
                label.into(),
                Arc::new(Mutex::new(BrowserMetadata {
                    document_generation,
                    ..Default::default()
                })),
            );
        }
        assert_eq!(stale_labels(&registry, 2).unwrap(), vec!["old"]);
        assert!(stale_labels(&registry, 1).unwrap().is_empty());
    }

    #[test]
    fn validates_favicons_and_rejects_previous_document_metadata() {
        let raw = r#"{"url":"https://example.com/","icons":["https://example.com/icon.svg","http://localhost:4174/icon.png","file:///private/icon","javascript:alert(1)","https://user:secret@example.com/icon"]}"#;
        assert_eq!(
            favicon_urls_from_response(raw, "https://example.com/"),
            vec![
                "https://example.com/icon.svg",
                "http://localhost:4174/icon.png"
            ]
        );
        assert!(favicon_urls_from_response(raw, "https://other.example/").is_empty());
        assert!(favicon_urls_from_response("null", "https://example.com/").is_empty());
        assert!(
            favicon_urls_from_response(&"x".repeat(80 * 1024 + 1), "https://example.com/")
                .is_empty()
        );
    }

    #[test]
    fn permits_web_navigation_and_local_development_servers() {
        for url in [
            "https://example.com/path?q=1#anchor",
            "http://localhost:3000",
            "http://[::1]:8080",
        ] {
            assert!(parse_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_privileged_and_executable_urls() {
        for url in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
            "tauri://localhost",
            "about:blank",
            "not a url",
        ] {
            assert!(parse_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn permits_only_the_internal_blank_page_at_creation() {
        assert!(parse_initial_url("about:blank").is_ok());
        assert!(allowed_navigation(&Url::parse("about:blank").unwrap()));
        assert!(parse_url("about:blank").is_err());
        for url in [
            "about:config",
            "about:blank#fragment",
            "about:blank?query",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(parse_initial_url(url).is_err(), "{url}");
            assert!(!allowed_navigation(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn only_main_can_control_sidebar_views() {
        assert!(authorized_labels("main", "main", "sidebar-webview-123"));
        assert!(!authorized_labels(
            "sidebar-webview-123",
            "main",
            "sidebar-webview-456"
        ));
        assert!(!authorized_labels("main", "other", "sidebar-webview-123"));
        assert!(!authorized_labels("main", "main", "main"));
        assert!(!authorized_labels("main", "main", "sidebar-webview-"));
        assert!(!authorized_labels(
            "main",
            "main",
            "sidebar-webview-../main"
        ));
    }
}
