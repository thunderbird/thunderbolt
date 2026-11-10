# Page and browser control

HTML artifacts, websites, and device-local apps share the page API. The agent discovers live sessions and their
capabilities, observes a page, and interacts through the adapter available on that device. The same document
can move between chat, the browser sidebar, and an expanded view without reloading.

See [unified pages](architecture/unified-pages.md) for persistence, project environments, and local-app storage.

## Agent contract

| Tool             | Behavior                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `page_list`      | List live sessions, presentation, and supported capabilities.                                                   |
| `page_open`      | Open an HTTP(S) website or blank page and publish a page card in chat.                                          |
| `page_select`    | Reveal a session without reloading it.                                                                          |
| `page_close`     | Close a live session; its pin remains saved.                                                                    |
| `page_snapshot`  | Read page text, document identity, viewport, and element references; optionally request a supported screenshot. |
| `page_navigate`  | Navigate, go back/forward, reload, or stop. Await loading before returning the observation.                     |
| `page_action`    | Move/click the visible cursor, type literal text, press a key, or scroll.                                       |
| `page_show_file` | Publish an HTML file created in the selected execution environment.                                             |
| `local_app`      | Start a supervised server from a device-local project and publish its page. Available only in that environment. |

`render_html` remains the tool for generating a self-contained HTML artifact. Tools advertise capabilities;
mobile omits `page_action`, and web external-URL cards offer an explicit link to the user's browser instead of
embedding arbitrary sites. Sandboxed HTML supports synthetic input on desktop web. Native desktop pages
support native input and screenshots. External ACP agents do not inherit the built-in agent's local tools.

The page controller owns activation and serializes observations, navigation, and input. Adapters wait for
presentation and loading before returning an observation. Snapshots are live, bypass the ordinary tool cache,
and return screenshots as image content rather than base64 text. Session IDs are public UUIDs; native labels
remain private to the adapter. Page content and screenshots are untrusted data, never agent instructions.

The activity controller owns turn lifetimes and Stop/Resume. Its banner persists through model thinking and
retries after a tool claims a page. Finishing a turn revokes its handles; simultaneous chats retain independent
activity. Stop aborts all current page-control signals. Resume permits new operations without reviving canceled
ones. Native input additionally uses begin/cancel operation tickets, checked after async preparation and
immediately before dispatch, so a queued click cannot run after Stop.

## Native boundary

Built-in tools use the app's existing owned webviews. A separate MCP or WebDriver server would add authentication,
discovery, and process management without improving access to these pages. No automation port, generic
JavaScript evaluator, or guest Tauri IPC bridge is exposed. Privileged commands accept only the main app webview
and resolve a registered page. They evaluate fixed internal scripts with serialized arguments.

| Platform | Input and screenshot adapter                                                    |
| -------- | ------------------------------------------------------------------------------- |
| macOS    | AppKit input directed at the owned WKWebView; WKWebView snapshot.               |
| Windows  | WebView2 in-process DevTools input and viewport capture; no exposed CDP server. |
| Linux    | GDK input and WebKitGTK editing commands; visible-region snapshot.              |

Native browser input preserves the user's app keyboard focus. The cursor is a rounded gradient arrow in a
closed shadow overlay; it does not move the system pointer or intercept user input. Main-app document reload
revokes pending native actions and closes the old generation's webviews so orphaned pages cannot cover the UI.

Tab favicons come from declared HTTP(S) icon links, with a same-origin `/favicon.ico` fallback. Metadata from an
old document is rejected. Icons load without a referrer or third-party favicon service. Failed images show the
globe icon.

The divider grip is a trusted local webview that can straddle native page boundaries. Its only privileged
operation is a validated resize gesture. Grip presentation errors are separate from page-loading errors.

## References and selection

The driver assigns references to actual DOM nodes within one document. Detached nodes and references from a
previous navigation are rejected. Before input it checks visibility, editability, disabled state, viewport
bounds, and whether a referenced click target is covered. It can observe open shadow roots; it does not traverse
frame documents or closed shadow roots. Use screenshots and viewport coordinates for those surfaces. Typing
without a ref preserves a focused field inside a frame or an open shadow root.

The element picker runs inside the page, suppresses the selected element's normal click action, highlights the
target, and handles Escape. A gesture carries a request ID, session, document, and owning chat. Navigation,
chat/tab changes, cancellation, and unmount invalidate it; late cancellation cannot cancel a newer gesture.
Validated selection text and reference metadata become the existing `data-quote` message part.

## Limits and validation

Coordinates are CSS pixels within the page viewport, excluding chrome. Screenshot dimensions may differ on
high-density displays and must be mapped to the reported viewport. Snapshots bound text and element counts and
omit password values; screenshots still include everything visibly rendered. Native permission dialogs, file
choosers, extensions, and general desktop automation are outside this contract.

Web HTML runs in an opaque-origin sandbox with an offline CSP and a document-scoped message nonce. Restoring a
local-app card does not start its server: launching requires a live authorized session or an explicit user action.
Browser shell commands run in isolated workers with time limits; local commands use supervised process trees.

Relevant checks:

```sh
bun test src/browser src/pages src/content-view src/components/artifact --timeout 5000
bun run type-check
bun run test:agent-core
bun run test:agent-core:browser
cargo test --manifest-path src-tauri/Cargo.toml --lib browser
```

The driver unit tests evaluate the actual native-included script in isolated page realms. Real-browser artifact
specs cover synthetic input and sandbox boundaries. Consumer page specs cover pinning, renaming, restoration,
and publication. Native smoke covers real tab lifetime, controls, and picker delivery; see
[native smoke setup](development/testing.md#native-app-smoke). Platform adapters must also compile and run on
their target OS; a macOS build alone does not validate Windows or Linux.

`page-driver.js` is embedded with Rust `include_str!`; rebuild and restart the native app after editing it.
