# Desktop browser control

The desktop browser exposes the user's existing tabs to the built-in agent. A shared controller connects typed
agent tools to Tauri commands, a small page observation script, and native input adapters. It also lets the user
select an element and attach its text and actionable reference to the current chat.

## Why this integration

Use built-in tools for the in-app agent. The app already owns the webviews and their lifetime, so a separate
automation server would add discovery, authentication, and process management without improving access to these
tabs. Tauri/Wry can evaluate a fixed script inside an owned webview and return its JSON result; the native layer
wraps exceptions explicitly because callback error behavior varies by platform/runtime version.
[Wry evaluation API](https://docs.rs/wry/latest/wry/struct.WebView.html#method.evaluate_script_with_callback).

WebDriver remains useful for end-to-end tests. Tauri's current WebdriverIO integration offers an embedded server
on all three desktop platforms; the direct `tauri-driver` route supports Windows and Linux. Neither server is
started for production browser control. [Tauri WebDriver documentation](https://v2.tauri.app/develop/tests/webdriver/).

Cua Driver is a viable separate integration for controlling external applications and existing Chromium windows.
Its browser interface targets a Chromium tab and its native process/window; that is a broader boundary than an
owned WKWebView, WebKitGTK widget, or WebView2 control. It is optional, not a dependency of this implementation.
[Cua's browser-control design](https://github.com/trycua/cua/blob/main/blog/extension-free-browser-use.md).

MCP can wrap the controller later if external agents need these tabs. That requires an authenticated device
connection, explicit scope, lifecycle, and cancellation. An HTTP endpoint also requires origin validation and
authentication; exposing an unauthenticated localhost control port is not an interoperability shortcut.
[MCP transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Agent contract

| Tool               | Behavior                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `browser_tabs`     | List, open, select, or close tabs. Opening can reveal a closed browser panel.                           |
| `browser_snapshot` | Read current page text, document ID, viewport, and visible element references; optionally return a PNG. |
| `browser_navigate` | Navigate to HTTP(S), go back/forward, reload, or stop loading; return fresh page state.                 |
| `browser_action`   | Move, click, type literal text, press a supported key/chord, or scroll; return fresh page state.        |

These tools are registered in `src/ai/fetch.ts` for tool-capable built-in agents on desktop, including both
the legacy and Pi engine paths. Hosted agents, external ACP agents, the web app, and mobile do not receive local
browser tools. Quote text still reaches those chat transports through the existing quote hydration path.

Tool tab IDs are public tab UUIDs. `browser-controller.ts` maps them to private native webview labels, activates
the correct tab, serializes operations, waits briefly for navigation to settle, and carries abort signals.
Snapshots are live and bypass the ordinary tool cache. Screenshots become image content for the model, not
base64 text. The browser chrome displays agent activity and provides Stop/Resume control. Activity belongs to
the chat turn, identified by its telemetry trace: after the first browser action, the banner stays on the last
controlled tab throughout model thinking and automatic retries. Success, terminal failure, chat Stop, closing
the tab, or closing the browser clears it. Turn-scoped tool handles reject late calls after completion, and
simultaneous chats cannot clear one another's activity. Stop control pauses all browser input immediately;
Resume allows new actions without reviving cancelled ones.

The agent's cursor is a rounded, brand-gradient arrow rendered in a closed shadow overlay. It cannot intercept
page input or move the system pointer, and its click animation stays anchored to the indicated hotspot.

References are generated per document and identify actual DOM objects. They remain stable across snapshots;
detached nodes and references from a previous navigation are rejected. Before input, the driver checks visibility,
editability, disabled state, viewport bounds, and whether another element covers a referenced click target.
The instruction prompt treats page observations as untrusted content and requires fresh observations and outcome
verification.

## Native boundary and platforms

The privileged commands in `src-tauri/src/browser_control.rs` accept only the main app webview as caller and
resolve a registered browser tab. They evaluate fixed internal operations with serialized arguments. There is no
agent-facing JavaScript evaluator, remote debugging port, generic shell execution, or Tauri IPC bridge exposed to
the remote page. The observation script lives in the page's realm, so its text and metadata are still untrusted.

| Platform | Input and screenshot adapter                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| macOS    | AppKit events and native text editing directed at the owned WKWebView; WKWebView snapshot.                 |
| Windows  | WebView2's in-process DevTools protocol methods for input and viewport capture.                            |
| Linux    | GDK events and WebKitGTK editing commands directed at the owned widget; WebKitGTK visible-region snapshot. |

The Windows adapter uses `CallDevToolsProtocolMethod` on the owned WebView2 instance, not an exposed CDP server.
[WebView2 API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2#calldevtoolsprotocolmethod).
Linux snapshot capture is asynchronous and targets the visible region.
[WebKitGTK snapshot API](https://webkitgtk.org/reference/webkit2gtk/stable/method.WebView.get_snapshot.html).
Adapters must be compiled and exercised on their target OS; a passing macOS build does not validate Windows or
Linux native code.

Browser input preserves the user's keyboard focus. DOM focus inside a page remains independent of the
native responder that receives the user's typing. macOS blocks background page requests to take first
responder status and filters only tagged agent keys that WebKit redispatches to the application. Linux
temporarily disables focus acquisition during native event dispatch and consumes tagged WebKit key replays.
Real user clicks and keyboard navigation still select the browser normally. Agent-created or closed tabs
also avoid moving focus into the address bar or adjacent tab controls.

Tab favicons come from the current document's declared HTTP(S) icon links, with a same-origin `/favicon.ico`
fallback. The native metadata poll rejects icon metadata from an earlier document after navigation. Icons
load without a referrer or a third-party favicon service; failed icons fall back to the globe.

The divider grip uses a small trusted local webview so it can straddle the native page boundary. It stays
centered on the divider and window, and is raised without activating the page. This webview may invoke only
the resize-gesture command; its owner token and gesture lifetime are validated before the main app changes
panel width. Grip presentation failures are separate from page-loading failures.

Browser-side shell commands run in a dedicated module worker per command. CPU-heavy scripts cannot block
the app's render/input thread, and Stop or the command timeout terminates the worker. Filesystem operations
are bounded RPC calls to the existing jailed filesystem; outstanding writes finish before a subsequent
command starts. Browser commands default to 30 seconds and are capped at 120 seconds. This isolation does
not change the CLI shell execution environment.

## Element selection

The picker renders inside the child webview because a React overlay cannot cover a native child view. It captures
the user's click, suppresses the page action, highlights the hovered element, and handles Escape. The app starts
a gesture with `browser_set_picker` and polls `browser_poll_picker` at 150 ms while waiting; no page-to-host IPC
permission is needed.

Each gesture carries a request ID and captures its public tab ID, document URL, and owning chat. Tab switches,
navigation, chat changes, cancellation, and unmount invalidate it. Native cancellation is request-scoped, so a
late cancellation cannot stop a newer gesture. A new document reports a missing gesture as cancelled.

`browser-element-reference.ts` validates and bounds the result. The selected text, URL, title, public tab ID,
element reference, and selector metadata become one existing `data-quote` part. The composer chip, persistence,
message rendering, and model/ACP hydration need no additional schema. Mini-app routes explicitly supply the open
chat ID and dismiss the covering browser after attachment; regular chat routes keep the browser open.

## Limits and testing

DOM snapshots inspect the top-level document and open shadow roots. They do not traverse frame documents or
closed shadow roots. Use screenshots and viewport coordinates for those surfaces; DOM references inside them
are not available. After a coordinate click focuses a field inside a frame, `type` without a `ref` preserves
the frame's native focus and enters text there. Referencing the outer iframe does not make it an editable target.
Coordinates are CSS pixels relative to the page viewport, excluding browser chrome. Image
pixel dimensions may differ on high-density displays and must be mapped to the reported viewport.

Snapshots bound text and element counts and omit password field values. A native screenshot can still show any
content visibly rendered on the page. Platform permission dialogs, file choosers, browser extensions, and general
desktop automation are outside the current tool contract.

Run the relevant checks:

```sh
bun test src/browser src/content-view --timeout 5000
bun run type-check
cargo test --manifest-path src-tauri/Cargo.toml
```

`page-driver.test.ts` evaluates the exact native-included script in isolated page realms. It covers stable/stale
references, plain-HTTP initialization, open shadow roots, private field omission, input validation, picker races,
and the absence of remote IPC. Hook tests cover chat ownership and cancelled asynchronous results. The Linux
native smoke covers actual tab lifetime/session behavior, browser controls, and selection-to-composer delivery
using local fixture pages; see [native smoke setup](development/testing.md#native-app-smoke).

`page-driver.js` is embedded with Rust `include_str!`. Rebuild and restart the native application after editing
it; refreshing Vite alone does not update the script embedded in a running executable.
