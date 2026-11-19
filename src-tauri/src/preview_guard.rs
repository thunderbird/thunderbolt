/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use tauri::Url;

/// Whether a webview may load `url` on Linux. WebKitGTK cannot tell which frame sent an IPC
/// message, so only `main` may load http(s) pages; other webviews keep app content, which Linux
/// serves from `tauri://localhost` (or the dev server in dev builds).
fn allows_navigation(label: &str, url: &Url, dev_url: Option<&Url>) -> bool {
    label == "main"
        || !matches!(url.scheme(), "http" | "https")
        || dev_url.is_some_and(|dev| dev.origin() == url.origin())
}

/// Cancels disallowed navigations in every webview, including ones created from JavaScript.
// shortcut: Tauri skips plugin hooks until it registers a JS-created webview, so the first load
// relies on registration winning that race; re-check the native smoke on Tauri/WebKitGTK upgrades.
#[cfg(target_os = "linux")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::Manager;

    tauri::plugin::Builder::new("linux-preview-guard")
        .on_navigation(|webview, url| {
            // Release builds must not trust a separate service listening on the dev port.
            let dev_url = webview
                .config()
                .build
                .dev_url
                .as_ref()
                .filter(|_| tauri::is_dev());
            allows_navigation(webview.label(), url, dev_url)
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allows(label: &str, url: &str, dev_url: Option<&str>) -> bool {
        let dev_url = dev_url.map(|dev| Url::parse(dev).unwrap());
        allows_navigation(label, &Url::parse(url).unwrap(), dev_url.as_ref())
    }

    #[test]
    fn main_webview_may_load_external_pages() {
        assert!(allows("main", "https://example.com/", None));
    }

    #[test]
    fn other_webviews_cannot_load_external_pages() {
        for url in [
            "https://example.com/",
            "http://example.com/",
            "http://localhost:1420/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "https://evil.tauri.localhost/",
        ] {
            assert!(!allows("sidebar-webview-1", url, None), "{url}");
        }
    }

    #[test]
    fn other_webviews_keep_app_content() {
        for url in ["tauri://localhost/index.html", "about:blank"] {
            assert!(allows("sidebar-webview-1", url, None), "{url}");
        }
    }

    #[test]
    fn dev_server_counts_as_app_content_only_on_its_own_origin() {
        let dev = Some("http://localhost:1420");
        assert!(allows(
            "sidebar-webview-1",
            "http://localhost:1420/index.html",
            dev
        ));
        assert!(!allows("sidebar-webview-1", "http://localhost:1421/", dev));
        assert!(!allows("sidebar-webview-1", "https://localhost:1420/", dev));
    }
}
