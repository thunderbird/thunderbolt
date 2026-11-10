# Unified pages and project environments

Pages replace the separate browser/mini-app/artifact navigation models. A `PageDefinition` identifies a URL, a self-contained HTML snapshot, or an opaque device-local app binding. A `PageSession` identifies a running document. Displaying a session inline, in the browser panel, or expanded changes its placement rather than creating another document.

## Interface and transports

`shared/page-protocol.ts` defines sources, presentations, capabilities, observations and actions. `page-controller.ts` routes operations to an adapter registered for the exact session. The built-in agent receives `page_list`, `page_open`, `page_select`, `page_close`, `page_snapshot` and `page_navigate`; `page_action` is omitted on native mobile. `page_show_file` publishes a verified HTML snapshot from the selected execution environment. `render_html` remains available for direct creation.

| Surface       | HTML                      | External URLs                  | Agent interaction                                                        |
| ------------- | ------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Web           | Sandboxed, offline iframe | Open in the user's browser     | Observation, element selection, synthetic HTML input                     |
| Desktop       | Same sandboxed iframe     | Native child webview           | Observation, selection, native input and screenshots for native pages    |
| iOS / Android | Same sandboxed iframe     | Isolated native mobile webview | Observation, navigation and element selection; no input/screenshot tools |

This is an internal typed interface, not an exposed MCP server. It requires no automation port or unauthenticated localhost bridge. It can later be adapted to MCP without changing document identities or renderer lifetimes. Capability negotiation and distinct display modes follow the useful separation in [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview); adopting its entire server transport would not itself provide native browser control.

The [VS Code integrated browser](https://code.visualstudio.com/docs/debugtest/integrated-browser) is relevant prior art for pages living beside code and agent work. Thunderbolt also needs inline chat presentation, so permanent renderer owners sit outside route trees. Layout slots provide full viewport dimensions and separate clipping; moving a React iframe between portal roots would recreate its browsing context.

Tauri's child-webview API is desktop-only. The mobile adapter therefore uses a [Tauri mobile plugin](https://v2.tauri.app/develop/plugins/develop-mobile/) with WKWebView and Android WebView implementations. Details, storage behavior and platform validation are in `src-tauri/tauri-plugin-pages/README.md`.

Web URL fallback is intentional. The obstacles are website framing restrictions and cross-origin DOM isolation, not simply CORS. HTML frames retain an opaque origin (`sandbox="allow-scripts"` without `allow-same-origin`) and an offline CSP. The [iframe documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) describes these sandbox boundaries. Proxying arbitrary websites is not part of this implementation.

## Page lifetime and interaction

- `PageSessionHosts` owns each renderer once; `PageSlot` reserves inline/sidebar/expanded geometry. Native clipping keeps the full viewport without placing invisible native input regions above chat controls.
- A closed tab destroys its session. A hidden panel preserves it. Inline-only documents are disposed after their last transcript slot unmounts; a transfer into the sidebar or expanded view keeps its document. Pins save the source and presentation preference, not live cookies, form fields, history, or screenshots.
- `Pin` opens with browser controls. `Pin as app` opens expanded without the URL/history toolbar. The sidebar stores pages instead of hosted mini-app definitions.
- HTML tool results remain in the transcript. Publishing a local app or URL also produces a page card. A local app missing from this device shows an explanation instead of using another machine's localhost address.
- Agent activity belongs to a chat turn, including model thinking between calls. Stop invalidates claimed operation signals. Late observations from closed/replaced sessions are rejected.
- Element references are scoped to the document. Observations and page text are untrusted. No arbitrary JavaScript-evaluation tool or host IPC bridge is exposed to guest pages.

Website/HTML pins use one encrypted settings value per opaque page ID. Existing settings sync supports this without a new backend table or rollout dependency. HTML pins retain their source independently of the originating chat. Local app pins and launch recipes use device-local storage; paths, executable arguments and resolved ports are absent from synced pin records. Saved HTML is verified before creating a fresh document.

## Project environments and local apps

The native-execution prototype from PR1380 (`edd91f800bec6a28184b40e8e3d446a8bf9dda53`) is merged. A project has one immutable environment declaration: computer, cloud, or Thunderbolt sandbox. Project chats inherit it. Existing projects default to sandbox. Standalone chats retain their own selector. Project chats currently require the built-in agent: external ACP and managed agents cannot bind this workspace and remain available in standalone chats. Existing incompatible selections are preserved with an actionable error, never silently changed. Moving a running chat between project environments is blocked until its turn stops. Cloud is represented but disabled until an actual cloud execution transport exists.

The environment kind syncs in a project setting. Computer folders and access grants remain local to the device. Opening an unbound computer project asks for its folder; it never silently runs in a sandbox instead. Project sandbox chats share a workspace, and disconnecting one chat does not remove it. Attachment rehydration preserves project edits. Native files are never deleted during chat cleanup.

`local_app` creates a device-local launch recipe from the current computer environment, starts a supervised process, waits for HTTP readiness, and opens its page. It also lists, inspects, restarts and stops those apps. The service allocates a loopback port, passes `PORT` and substitutes `{port}` arguments, bounds logs, and terminates process trees. Servers survive agent turns and stop on explicit stop, identity cleanup or app exit. Restart publishes the new URL to the same page session. Startup is shared across simultaneous consumers, so a Strict Mode remount cannot cancel another consumer's server.

Shell commands and previews share process ownership. Unix uses process groups and stops live descendants before reaping their parents. Windows starts a native process suspended, assigns it to a non-inheritable, kill-on-close Job Object, then resumes its primary thread. Cancellation, timeout, normal root exit, and application exit terminate the job's descendants. Stop captures identity-checked member handles, terminates them, repeats discovery for children spawned during shutdown, and waits for the process handles to signal exit before returning. Job accounting alone can reach zero before a child's resources close. Shutdown has a bounded wait and requests job-wide termination even when that wait fails. The Windows CI job exercises this lifecycle and immediate fixed-port reuse, and checks the complete native desktop build.

## Platform limits

macOS native behavior is exercised with real WKWebViews, including clipping, focus preservation, visibility and state retention. iOS has real simulator tests for isolated cookies, clipping and lifecycle. The Windows and Linux clipping functions pass platform API typechecks; full target app builds and visual behavior still require platform build/device checks; Linux partial clipping uses native regions and reports unsupported compositors instead of painting over chat. Android requires a WebView with isolated profile support. Android release builds retain HTTPS-only policy, while iOS permits HTTP specifically for web content. Android SDK/JDK validation remains necessary before release. Native coding shell execution requires Bash. Windows resolves Git Bash/MSYS2 from PATH or standard Git installation directories; it rejects the WSL shim because Linux processes created through WSL do not belong to a Win32 Job Object. Native host execution is not a security sandbox or containment for programs deliberately delegating work to an external service.

Synchronous infinite loops in HTML iframe scripts can still block the web renderer; an iframe timeout cannot interrupt them. This is an existing artifact limitation, not a claim of process isolation. A separate-origin renderer/worker execution strategy would be a separate project.
