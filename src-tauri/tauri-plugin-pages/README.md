# Native mobile pages

This plugin creates plain `WKWebView` (iOS) and `WebView` (Android) surfaces alongside the trusted Tauri main webview. It deliberately does not create additional Tauri webviews or expose the host IPC bridge to pages. Tauri's desktop child-webview API is unavailable on mobile.

The TypeScript adapter exposes the same page controller contract as the desktop and HTML renderers. Mobile capabilities include navigation, page context and element selection. Screenshot, pointer and keyboard automation are unavailable. Users can still interact with a page normally.

`create`, `present`, `navigate`, `action`, `state`, `close`, `snapshot`, `set_picker` and `poll_picker` are restricted to the main app webview. The internal native `evaluate` command is not registered as a frontend Rust command. Only the bundled fixed observation/selection driver is evaluated. Guest JavaScript gets no filesystem, process, or Tauri command access.

Page dimensions describe the full CSS viewport, with a separate clipping inset. Changing presentation moves and clips the existing native view without navigating it. Host-page navigation advances a generation and destroys old views; delayed creation from an old document is rejected. Hide/close operations bypass observation serialization so an unresponsive guest script cannot keep a surface in front of the app.

## Storage and transport

- iOS tabs share one private, nonpersistent `WKWebsiteDataStore`; it is separate from the app's store. Cookies survive tab changes but not app termination.
- Android tabs share the dedicated `thunderbolt-browser-pages` profile. This profile persists across app restarts and is separate from the host profile. `MULTI_PROFILE` support is required; older Android System WebView installations report unavailable instead of silently sharing the trusted app's cookies.
- Top-level navigation only accepts HTTP(S) and `about:blank`. Native file/content access and Android mixed-content loading are disabled. Popups become ordinary page tabs.
- iOS `Info.plist` permits HTTP in WebKit content with `NSAllowsArbitraryLoadsInWebContent`; native `URLSession` ATS policy remains unchanged.
- Android retains the application's existing transport policy: debug builds allow HTTP, release builds require HTTPS. Android has no per-WebView equivalent of the iOS web-content ATS exception. Release HTTP support needs an explicit app transport-policy decision; this plugin does not silently relax it.

## Verification

`cargo test -p tauri-plugin-pages` covers URL/label/bounds validation and bounded observation decoding. `cargo check -p tauri-plugin-pages --target aarch64-apple-ios-sim` checks the mobile Rust bridge.

The Swift package's `PagesTests` target runs on an iOS simulator. It exercises real native webviews: guest/host storage isolation, absence of the Tauri bridge, preservation of DOM state while moving/clipping the view, close, and generation cleanup including stale creation rejection. Run `xcodebuild -scheme tauri-plugin-pages -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO test` from `ios` after Tauri has generated `.tauri/tauri-api` for the plugin.

Android source still requires validation with an installed Android SDK/JDK and a modern System WebView. The implementation host used for this change has neither an Android SDK nor a Java runtime; no Android build or device result is claimed.

Primary API references:

- [Tauri desktop-only child webviews](https://docs.rs/tauri/2.12.5/tauri/window/struct.Window.html#method.add_child)
- [Tauri mobile plugin development](https://v2.tauri.app/develop/plugins/develop-mobile/)
- [Android WebView profiles](https://developer.android.com/reference/androidx/webkit/WebViewCompat#setProfile(android.webkit.WebView,java.lang.String))
- [Apple WebKit-only ATS exception](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloadsinwebcontent)
