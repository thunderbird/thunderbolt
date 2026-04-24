# WebView Feature

> ⚠️ **Experimental Feature**: This feature has not undergone extensive privacy or security evaluations and may be placed behind a preview feature flag before public release.
>
> **Platform Availability**: Only works in desktop and mobile apps—not in web browsers (requires Tauri's native WebView APIs).
>
> **Testing Status**: Only tested on macOS. Other platforms (Windows, Linux, iOS, Android) are untested.

## Overview

The WebView feature displays web pages directly in the application sidebar using native browser components. Links in the AI assistant open in an embedded WebView instead of launching an external browser.

**Platform engines:**

- **macOS**: WebKit (WKWebView) ✅ _Tested_
- **Windows**: Microsoft Edge WebView2 (Chromium) ⚠️ _Untested_
- **Linux**: WebKit (webkit2gtk) ⚠️ _Untested_
- **iOS**: WebKit (WKWebView) ⚠️ _Untested_
- **Android**: WebView ⚠️ _Untested_

## Privacy & Incognito Mode

WebViews run in **incognito mode** by default (`incognito: true`). Following [Tauri's recommended architecture](https://v1.tauri.app/v1/references/architecture/process-model/), **a new WebView is created each time** you open a page and destroyed when closed.

> **Note**: Incognito mode is not supported on all operating systems. Android is known to not support it—on unsupported platforms, the WebView will fall back to normal mode with data persistence.

**Benefits:**

- No browsing history, cookies, or cache persisted to disk
- No data leakage between page loads
- Blocks WebCrypto API keychain access

**Trade-offs:**

- **No login persistence**: You can log in, but sessions won't persist between page loads (you'll need to log in again each time)
- **Performance cost**: WebView creation/destruction is slow and resource-intensive
- **IP exposure**: Unlike the main AI experience (which uses a backend proxy), WebView pages expose your IP address and fingerprintable device information directly to websites

**Recommendations:**

- Use a VPN when browsing sensitive content
- Open authenticated sites in your external browser with privacy extensions
- Be aware each page exposes your identity to that website

## Limitations

- **No browser extensions**: No ad blockers, password managers, or privacy tools (fundamental WebView limitation)
- **No cross-page state**: Each page starts fresh
- **Slower than browser**: Creating WebViews has noticeable startup delay

## Known Issues

### 1. Drag Handle Overlap

WebView overlaps the sidebar drag handle by ~2px, making resizing slightly harder.

### 2. Window Freezing with Rapid Page Loads

Opening 3+ pages in rapid succession causes the entire window to freeze (possible race condition or memory leak). **Workaround**: Wait for each page to load before opening another.

**Investigating**: Race conditions in WebView lifecycle, resource exhaustion, event listener cleanup issues.

### 3. System Password Prompt for WebCrypto

Some websites using WebCrypto API trigger an OS-level system prompt asking for the user's password to access keychain storage. This occurs even with incognito mode enabled and can be disruptive and confusing.

**Investigating**: May require additional WebView configuration or Tauri-level sandboxing to prevent keychain access attempts.

## Technical Implementation

**Frontend:**

- `src/content-view/use-sidebar-webview.ts` - Lifecycle management
- `src/content-view/sidebar-webview.tsx` - UI component

**Backend (Tauri):**

- Requires `unstable` feature flag in `Cargo.toml`
- Permissions in `src-tauri/capabilities/default.json`

**Configuration:**

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

## Future Improvements

- Feature flag for opt-in testing
- Privacy warnings before opening external pages
- VPN integration or detection
- WebView pooling/reuse for better performance
- Content filtering/ad blocking at Tauri level
- Security audit before public release

**Feedback**: Report issues or suggestions to the development team.
