# WebView

> ⚠️ **Experimental**: not extensively privacy- or security-evaluated; may ship behind a preview flag.
>
> **Platform**: desktop and mobile apps only, not web browsers (requires Tauri's native WebView APIs).
>
> **Testing**: macOS only. Windows, Linux, iOS and Android are untested.

## Overview

The WebView feature displays web pages in the application sidebar using native browser components.

Where a link in the AI assistant opens is a user preference: **External Links** in Settings → Preferences, backed by `externalLinkBehavior` in the device-local settings store.

| Value           | Behavior                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `ask` (default) | Confirmation dialog naming the URL, offering the sidebar WebView (desktop) or an external open   |
| `sidebar`       | Sidebar WebView immediately. Desktop only; degrades to `ask` where the side panel is unavailable |
| `browser`       | OS browser (or a new tab on web) immediately, no confirmation                                    |

| Platform | Engine                             | Status      |
| -------- | ---------------------------------- | ----------- |
| macOS    | WebKit (WKWebView)                 | ✅ Tested   |
| Windows  | Microsoft Edge WebView2 (Chromium) | ⚠️ Untested |
| Linux    | WebKit (webkit2gtk)                | ⚠️ Untested |
| iOS      | WebKit (WKWebView)                 | ⚠️ Untested |
| Android  | WebView                            | ⚠️ Untested |

## Privacy and incognito mode

WebViews run in incognito mode by default (`incognito: true`). Following [Tauri's recommended architecture](https://v1.tauri.app/v1/references/architecture/process-model/), a new WebView is created each time you open a page and destroyed when closed.

> **Note**: not every OS supports incognito. Android is known not to. Where it is unsupported, the WebView falls back to normal mode with data persistence.

Benefits:

- No history, cookies, or cache persisted to disk
- No data leakage between page loads
- Blocks WebCrypto API keychain access

Trade-offs:

- **No login persistence**: you can log in, but sessions do not survive a page load
- **Performance**: WebView creation and destruction is slow and resource-intensive
- **IP exposure**: unlike the main AI experience (which uses a backend proxy), WebView pages expose your IP and fingerprintable device information directly to websites

Recommendations: use a VPN for sensitive content, and open authenticated sites in an external browser with privacy extensions.

## Limitations

- **No browser extensions**: no ad blockers, password managers, or privacy tools (fundamental WebView limitation)
- **No cross-page state**: each page starts fresh
- **Slower than a browser**: WebView creation has a noticeable startup delay

## Known issues

| Issue                        | Detail                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Drag handle overlap          | WebView overlaps the sidebar drag handle by ~2px, making resizing harder                                                    |
| Window freeze on rapid loads | Opening 3+ pages in quick succession freezes the window (race condition or memory leak). Wait for each load before the next |
| WebCrypto password prompt    | Some WebCrypto sites trigger an OS keychain password prompt, even in incognito                                              |

Under investigation: WebView lifecycle race conditions, resource exhaustion, event listener cleanup, and whether extra WebView configuration or Tauri-level sandboxing can block keychain access.

## Implementation

| Piece              | Location                                  |
| ------------------ | ----------------------------------------- |
| Lifecycle          | `src/content-view/use-sidebar-webview.ts` |
| UI                 | `src/content-view/sidebar-webview.tsx`    |
| Tauri feature flag | `unstable` in `Cargo.toml`                |
| Tauri permissions  | `src-tauri/capabilities/default.json`     |

```typescript
const webviewOptions: WebviewOptions = {
  url: config.url,
  x: Math.floor(rect.left) + borderOffset,
  y: webviewTop,
  width: Math.floor(rect.width) - borderOffset,
  height: webviewHeight,
  incognito: true, // Privacy mode
}

// Unique label prevents conflicts
const webviewLabel = `sidebar-webview-${Date.now()}`
const webview = new Webview(windowRef.current, webviewLabel, webviewOptions)
```

## Future improvements

- Feature flag for opt-in testing
- VPN integration or detection
- WebView pooling/reuse
- Content filtering/ad blocking at the Tauri level
- Security audit before public release
