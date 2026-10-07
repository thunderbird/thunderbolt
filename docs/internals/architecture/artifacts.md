# HTML Artifacts

An **artifact** is a self-contained HTML page the model writes and the app runs
in the user's browser. It is the one place model-authored code executes on the
user's device.

**There is no `artifacts` table.** An artifact is a `render_html` tool call
inside an assistant message's `parts` JSON, and the rendered page is read back
from the call's **input** rather than its output
([`src/artifacts/render-html-tool.ts`](../../../src/artifacts/render-html-tool.ts)).
So:

- Artifacts sync with their chat like any other message content.
- They survive a reload without re-verifying; the persisted verdict is trusted.
- A project can aggregate them with a query over message rows.

## Where the code lives

| Path                                            | Role                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `src/artifacts/constants.ts`                    | The shared tool name                                         |
| `src/artifacts/render-html-tool.ts`             | Tool definition, part guards, typed input/output accessors   |
| `src/artifacts/static-check.ts`                 | Inline JS/CSS parse and blocked-resource detection           |
| `src/artifacts/verify-html.ts`                  | Two-stage verification and the hidden-iframe runtime pass    |
| `src/artifacts/harness.ts`                      | CSP, injected harness script, message parsing, HTML wrappers |
| `src/components/artifact/`                      | `SandboxedHtmlFrame`, header actions, error strip            |
| `src/components/chat/artifact-message-part.tsx` | Transcript placement and the inline ↔ panel toggle           |
| `src/components/chat/inline-artifact-card.tsx`  | The inline card, streaming preview, activation gating        |
| `src/content-view/artifact-sidebar-content.tsx` | The side-panel view                                          |
| `src/lib/assistant-message.ts`                  | Lifting the part out of the tool group                       |
| `src/dal/projects.ts`                           | Project-level aggregation                                    |

Unit tests sit beside the `src/artifacts/` modules, `sandboxed-html-frame.tsx`
and `artifact-message-part.tsx`. `e2e/artifact-harness.spec.ts` covers what
happy-dom cannot: sandboxed-iframe script execution, the postMessage protocol,
in-engine CSP.

## The tool

`render_html`
([`src/artifacts/render-html-tool.ts`](../../../src/artifacts/render-html-tool.ts))
takes `html` and `title`, returns `{ ok: true }` or `{ ok: false, errors }`, and
is the only unconditional entry in `baseTools`
([`src/lib/tools.ts:50`](../../../src/lib/tools.ts)); everything else
`getAvailableTools` returns is gated on a setting or an integration. Errors are phrased for the model to self-correct in the same turn; the
HTML is never echoed back.

The `html` description is a contract, not a style note:

- Self-contained: all CSS in `<style>`, all JS in `<script>`, images and fonts
  as `data:` URIs, no network use. The CSP below blocks all of it, so a page
  that ignores the contract fails verification rather than rendering
  half-broken.
- No `100vh` layouts; the frame is sized to content height.

Workspace files are invisible to the user, so the environment prompt routes
final content to the reply "or use the `render_html` tool when appropriate"
([`shared/agent-core/environment-prompt.ts:13`](../../../shared/agent-core/environment-prompt.ts)).

## Verification

`verifyArtifactHtml`
([`src/artifacts/verify-html.ts`](../../../src/artifacts/verify-html.ts)) runs two
stages before the model is told anything.

### Stage 1: static check

[`src/artifacts/static-check.ts`](../../../src/artifacts/static-check.ts) parses
the document with `DOMParser`, then inline `<script>` and `<style>` blocks with
acorn and css-tree (imported on demand, to stay out of the entry bundle).
Syntax errors carry line and column.

| Class                             | Notes                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS syntax errors                  | Only in scripts whose `type` the browser would actually run as JS; importmaps, JSON data islands and templates are skipped.                                                                               |
| CSS syntax errors                 | Collected in tolerant mode so one bad rule does not hide the rest. Browsers silently drop invalid CSS, so nothing else would surface it.                                                                  |
| References the offline CSP blocks | Any `<script src>` or `<link rel=stylesheet>`, and any ES module specifier. These would not throw (the page would render blank or unstyled and pass a runtime check), so they are caught here on purpose. |

### Stage 2: runtime check

`runIframeVerification` mounts the wrapped HTML in a hidden
`sandbox="allow-scripts"` iframe off-screen and waits for the harness's
`postMessage`:

- An error message resolves `{ ok: false }` immediately.
- The first `artifact-ready` cancels the 4 s hard timeout and opens a 250 ms
  grace window for a late async failure.
- Repeat `ready` messages are ignored, so a page cannot defer completion forever
  by re-sending one.

Two limits before you trust a pass:

- A sandboxed `srcdoc` iframe shares the parent's main thread, so a
  _synchronous_ infinite loop blocks the event loop and the hard timer never
  fires. Real isolation needs a Worker or a cross-origin frame; accepted because
  artifacts are model-authored, not adversarial
  ([`src/artifacts/verify-html.ts:92`](../../../src/artifacts/verify-html.ts)).
- `skipRuntime` skips this stage for non-DOM contexts; only tests pass it.

## The sandbox

Two independent mechanisms contain an artifact; neither is optional.

### CSP

`artifactCsp` ([`src/artifacts/harness.ts:34`](../../../src/artifacts/harness.ts))
is injected as a `<meta http-equiv>` at the very start of `<head>`:

```text
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:;
base-uri 'none'; form-action 'none'
```

Inline JS and CSS run (and may `eval`) and `data:`/`blob:` media loads;
everything else is denied. `connect-src` inherits `default-src 'none'`: no
`fetch`, XHR or WebSocket.

### iframe sandbox

`allow-scripts`, never `allow-same-origin`: together they would hand the page
the parent origin and undo the sandbox. The pairing appears in three places and
must stay identical in all of them:

| Site                               | File                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Verification                       | [`src/artifacts/verify-html.ts:48`](../../../src/artifacts/verify-html.ts)                                          |
| Visible renderer                   | [`src/components/artifact/sandboxed-html-frame.tsx:111`](../../../src/components/artifact/sandboxed-html-frame.tsx) |
| Harness-protocol real-browser test | `e2e/artifact-harness.spec.ts`                                                                                      |

### The residual hole

A script can still navigate its own frame (`location = …`, a refresh meta),
which is an outbound GET no fetch directive sees. No CSP or sandbox token closes
it cleanly, so the rule is absolute: **never pass sensitive user-entered input
into an artifact**
([`src/artifacts/harness.ts:29`](../../../src/artifacts/harness.ts)). Do not weaken
it without closing the hole first.

### Verification is a quality gate, not the security boundary

The verdict is persisted and trusted on reload, and a remote producer verifies
wherever it runs ([Who can produce one](#who-can-produce-one)), so the sandbox
and the CSP are what actually hold. A visible render only ever happens after
verification and both use the same `wrapArtifactHtml`, so a page that dodges the
injection never sends `artifact-ready` and is rejected rather than shown without
its CSP. **Do not add a render path that skips verification.**

## The harness protocol

`wrapArtifactHtml(html, nonce)` splices the CSP meta tag and a small
error-reporting script into `<head>`, creating one if the document has none. It
is the first script in the document, so its listeners install before any
model-authored code can throw or overwrite `window.onerror`.

It posts `artifact-ready`, `artifact-height` and `artifact-error` (exception or
unhandled rejection), each carrying a per-render `artifactNonce` so one page
cannot spoof another's result. `parseHarnessMessage` is the single validator of
`event.source` and the nonce, so verifier and renderer cannot drift apart.

Details that look arbitrary but are not:

- Failed subresource loads are ignored: a 404 image must not fail an otherwise
  working page, and the static check already rejects the blocked cases.
- Height comes from `document.body.scrollHeight`, not `documentElement`, whose
  height is floored at the viewport height the parent just set: that would make
  the reported height monotonic and leave dead space under a shrinking artifact.
- `ResizeObserver` bursts are coalesced to one report per animation frame.
- The parent clamps reported height to between 60 px and 20,000 px and ignores
  sub-pixel jitter, so a page that knows its own nonce cannot blow out the
  transcript
  ([`src/components/artifact/sandboxed-html-frame.tsx:11`](../../../src/components/artifact/sandboxed-html-frame.tsx)).

`wrapArtifactPreviewHtml` injects the CSP and _no_ harness, for the two places
scripts are off: the streaming preview and the downloaded `.html` file, which
therefore still opens under the offline policy.

## Surfaces

`ArtifactMessagePart`
([`src/components/chat/artifact-message-part.tsx`](../../../src/components/chat/artifact-message-part.tsx))
picks one of three states:

| State                       | What renders                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| Streaming                   | An inline card with a live, **scripts-off** preview of the partial HTML |
| Verified, panel closed      | The interactive inline card                                             |
| Verified, open in the panel | A slim "shown in side panel" bar with a _Show inline_ button            |

`groupMessageParts` lifts the artifact out of the tool-call group, gated on
`artifactRendersStandalone`
([`src/lib/assistant-message.ts:53`](../../../src/lib/assistant-message.ts)): it
lifts out from the moment the call starts and while it verifies; only a
_finished_ call that failed or errored stays in the group as an ordinary tool
call.

### Inline vs. side panel

An artifact lives inline or in the side panel, never both. The panel is one of
four open `ContentViewState` kinds (`object-view`, `preview`, `sideview`,
`artifact`, plus a closed state;
[`src/content-view/context.tsx:37`](../../../src/content-view/context.tsx)),
mounted by `main-layout.tsx` and rendered by
[`src/content-view/artifact-sidebar-content.tsx`](../../../src/content-view/artifact-sidebar-content.tsx).
Both surfaces share `SandboxedHtmlFrame`, `ArtifactActions` (copy source,
download) and `ArtifactErrorStrip`, so a post-load runtime error looks the same
in either.

### Streaming and script activation

- The streaming preview is throttled to 120 ms so token updates do not thrash
  the iframe, and no frame appears until the partial HTML has something
  renderable in `<body>`.
- `useAppSettled` delays the first artifact's scripts ~1 s so the initial page
  load finishes first.
- `useOnScreen` holds an artifact below the fold until it is scrolled near.
- Both gates latch: flipping either back would reload the iframe and lose the
  page's state.

## Who can produce one

Recognition keys on the tool **name** alone (`renderHtmlToolName`,
[`src/artifacts/constants.ts`](../../../src/artifacts/constants.ts)), matched
against typed `tool-<name>` parts and MCP `dynamic-tool` parts. Three producers
reach the same frame:

- **The built-in agent**, whose `execute` runs the full verification in the
  browser.
- **Remote ACP agents.** The ACP layer forwards pi's whole `AgentToolResult` as
  `rawOutput`, so the `{ ok }` verdict arrives one level down under `details`.
  `renderHtmlOutput` reads both shapes; before it did, every hosted agent's
  artifact was stuck in the tool group as a plain tool call (#1286).
- **Any MCP server** exposing a tool called `render_html` that returns a
  matching verdict.

That widening is safe only because the CSP and sandbox are applied by the
renderer, not by the tool.

## Projects, persistence, sync

Artifacts are message content: normal chat sync, no table, no migration, no
reconciliation. `useProjectArtifacts`
([`src/dal/projects.ts`](../../../src/dal/projects.ts)) scans a project's messages
for `render_html` parts, newest-first.

- A `parts LIKE '%render_html%'` filter narrows the scan before any JSON is
  parsed.
- An artifact's key is `messageId-index`, since one message can emit several
  calls and two can share a title.
- That query assumes message JSON is plaintext locally, called out as untested
  under E2EE in [projects.md](projects.md#known-gaps). The same caveat applies
  to the FTS index.
