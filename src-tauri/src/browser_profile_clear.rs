/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use tauri::webview::PlatformWebview;
use tokio::sync::oneshot::Sender;

/// Starts clearing this WebView's profile on the UI thread and reports native completion.
/// The caller must retain the WebView until `completed` resolves.
#[cfg(target_os = "linux")]
pub(crate) fn clear(
    native: PlatformWebview,
    completed: Sender<Result<(), String>>,
) -> Result<(), String> {
    use webkit2gtk::{WebContextExt, WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};

    let manager = native
        .inner()
        .context()
        .and_then(|context| context.website_data_manager())
        .ok_or_else(|| "Browser profile data manager is unavailable".to_string())?;

    manager.clear(
        WebsiteDataTypes::ALL,
        webkit2gtk::glib::TimeSpan::from_seconds(0),
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| {
            let _ = completed.send(result.map_err(|error| error.to_string()));
        },
    );
    Ok(())
}

/// Starts clearing this WebView's profile on the UI thread and reports native completion.
/// The caller must retain the WebView until `completed` resolves.
#[cfg(target_os = "windows")]
pub(crate) fn clear(
    native: PlatformWebview,
    completed: Sender<Result<(), String>>,
) -> Result<(), String> {
    use webview2_com::{
        ClearBrowsingDataCompletedHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile2, ICoreWebView2_13},
    };
    use windows::core::Interface;

    let start_clear = || -> windows::core::Result<()> {
        // Tauri invokes this through `with_webview` on the controller's UI thread.
        unsafe {
            let profile = native
                .controller()
                .CoreWebView2()?
                .cast::<ICoreWebView2_13>()?
                .Profile()?
                .cast::<ICoreWebView2Profile2>()?;
            profile.ClearBrowsingDataAll(&ClearBrowsingDataCompletedHandler::create(Box::new(
                move |result| {
                    let _ = completed.send(result.map_err(|error| error.to_string()));
                    Ok(())
                },
            )))
        }
    };

    start_clear().map_err(|error| error.to_string())
}

/// Await the WK data-store completion callback instead of only scheduling deletion.
#[cfg(target_os = "macos")]
pub(crate) fn clear(
    native: PlatformWebview,
    completed: Sender<Result<(), String>>,
) -> Result<(), String> {
    use objc2_foundation::NSDate;
    use objc2_web_kit::{WKWebView, WKWebsiteDataStore};
    use std::cell::RefCell;

    let main_thread =
        objc2::MainThreadMarker::new().ok_or("Browser profile cleanup requires the UI thread")?;
    let completed = RefCell::new(Some(completed));
    let handler = block2::RcBlock::new(move || {
        if let Some(completed) = completed.borrow_mut().take() {
            let _ = completed.send(Ok(()));
        }
    });
    // SAFETY: Tauri supplies this live WKWebView on its UI thread. WebKit retains
    // the completion block; the caller retains the view until it completes.
    unsafe {
        let view = &*(native.inner() as *const WKWebView);
        view.configuration()
            .websiteDataStore()
            .removeDataOfTypes_modifiedSince_completionHandler(
                &WKWebsiteDataStore::allWebsiteDataTypes(main_thread),
                &NSDate::dateWithTimeIntervalSince1970(0.0),
                &handler,
            );
    }
    Ok(())
}
