# Tauri browser-surface isolation patch

This directory contains the published `tauri` **2.12.5** crate from crates.io.
The upstream crate checksum recorded in Thunderbolt's original Cargo.lock is
`5fb0244332cfb9cee7e2a568bf5da29a36ed8fdbd717f6f47a66b6b7b358c072`.
Upstream: <https://github.com/tauri-apps/tauri/tree/tauri-v2.12.5/crates/tauri>.
Original copyright notices and `LICENSE-MIT` / `LICENSE-APACHE-2.0` are retained.
Cargo cache metadata and the crate's standalone lockfile are not copied.

Only `src/webview/mod.rs` and `src/manager/webview.rs` change upstream behavior.
A local `rustfmt.toml` preserves upstream's two-space style for workspace formatting.
They add `WebviewBuilder::disable_native_api()`, which is off by default and
explicitly selected only for Thunderbolt's untrusted browser tabs. The main app
and trusted resize grip retain their ordinary Tauri runtime.
The method follows `WebviewBuilder`'s `unstable` feature gate, so plugin-only
builds without that feature do not gain an unreachable internal method.

Untrusted pages receive none of Tauri's or its plugins' initialization scripts,
including the immutable `window.isTauri` marker that otherwise causes Tauri web
apps to incorrectly choose native storage. They also receive no IPC handler or
app/custom URI protocols. Explicit builder initialization scripts are retained,
and Rust can still evaluate scripts, inspect DOM, capture screenshots, navigate,
and control the native webview. This takes effect before the first document and
on every subsequent navigation, using the same runtime path on macOS, Linux,
and Windows. It does not grant remote pages native permissions. The current
tauri-runtime-wry still installs Wry's `window.ipc` shim when no handler is
provided; that shim is inert and cannot reach Tauri commands. Tauri's own
`isTauri`, `__TAURI__`, `__TAURI_INTERNALS__`, and plugin runtime globals are absent.

Host page-load, navigation, and webview-ready hooks remain available. Plugins or
app code that explicitly evaluate scripts from those hooks are trusted native
code and must scope privileged injection to trusted webviews. The current
plugins do not inject from these hooks; Thunderbolt's app page-load handler
explicitly checks the `main` webview label.

The patch intentionally lives before the platform runtime rather than trying to
delete globals from JavaScript: Tauri defines the detection marker and bridge
as non-configurable properties, and injects them before builder scripts. Removing
platform scripts after creation is not portable because Wry does not retain the
WebView2 initialization-script identifiers.

When upgrading Tauri, replace this directory with the new published crate,
reapply or remove the two-file patch, and rerun the isolation regression tests
and native browser smoke. Prefer an upstream equivalent API when available.
