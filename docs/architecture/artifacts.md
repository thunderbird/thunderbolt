# HTML Artifacts

An **artifact** is a self-contained HTML page the model writes and the app runs
in the user's browser — a chart, a dashboard, a diagram, a small interactive
app. It is the one place where model-authored code executes on the user's
device, so most of this document is about the boundary around it.

There is no `artifacts` table. An artifact is a `render_html` tool call living
inside an assistant message's `parts` JSON, and the page that gets rendered is
read back from the call's **input** rather than its output
([`src/artifacts/render-html-tool.ts`](../../src/artifacts/render-html-tool.ts)).
That one decision explains most of the rest: artifacts sync with their chat
like any other message content, they survive a reload without re-verifying (the
persisted verdict is trusted), and a project can aggregate them with a query
over message rows.

## The tool

`render_html` is defined in
[`src/artifacts/render-html-tool.ts`](../../src/artifacts/render-html-tool.ts)
and registered in `getAvailableTools` as the only unconditional entry in
`baseTools` — "render_html is a core capability, always available regardless of
integrations" ([`src/lib/tools.ts:50`](../../src/lib/tools.ts)). Everything
else that function returns is conditional on a setting, an integration, or Pro
access.

It takes two parameters, `html` and `title`. The `html` description is a
contract, not a style note: the page must be complete and self-contained, with
all CSS in `<style>`, all JS in `<script>`, images and fonts as `data:` URIs,
and no network use of any kind — because the CSP below actually blocks all of
that, and a page that ignores the contract fails verification rather than
rendering half-broken. It also tells the model to avoid `100vh` layouts, since
the frame is sized to content height rather than to a viewport.

The output is deliberately thin: `{ ok: true }`, or `{ ok: false, errors }`
where the errors are phrased for the model to read and self-correct in the same
turn. The HTML is never echoed back — the renderer already has it from the
input.

The app harness's environment prompt nudges the model toward it explicitly:
workspace files are invisible to the user, so final content is delivered in the
reply "or use the `render_html` tool when appropriate"
([`shared/agent-core/environment-prompt.ts:13`](../../shared/agent-core/environment-prompt.ts)).

## Verification

`verifyArtifactHtml`
([`src/artifacts/verify-html.ts`](../../src/artifacts/verify-html.ts)) runs
before the model is told anything, in two stages.

**Static check** ([`src/artifacts/static-check.ts`](../../src/artifacts/static-check.ts))
parses the document with the platform's own `DOMParser`, pulls out inline
`<script>` and `<style>` blocks, and parses them with acorn and css-tree. Both
libraries are imported on demand so they stay out of the entry bundle. Three
classes of problem are reported, the two syntax classes with line and column:

- JS syntax errors (only in scripts whose `type` the browser would actually run
  as JS — importmaps, JSON data islands and templates are skipped).
- CSS syntax errors, collected in tolerant mode so one bad rule does not hide
  the rest. Browsers silently drop invalid CSS, so nothing else would surface it.
- References the offline CSP will block: any `<script src>` or
  `<link rel=stylesheet>`, and any ES module specifier. These would not throw —
  the page would render blank or unstyled and pass a runtime check — so they are
  caught here on purpose.

**Runtime check** (`runIframeVerification`) mounts the wrapped HTML in a hidden
`sandbox="allow-scripts"` iframe off-screen and waits for the harness's
`postMessage`. An error message resolves `{ ok: false }` immediately; the first
`artifact-ready` cancels the 4 s hard timeout and opens a 250 ms grace window
for a late async failure. Repeat `ready` messages are ignored, so a page cannot
defer completion forever by re-sending one.

Two limits are documented in the code and worth knowing before you trust the
pass. A sandboxed `srcdoc` iframe shares the parent's main thread, so a
_synchronous_ infinite loop blocks the event loop and the hard timer never
fires; real isolation would need a Worker or a cross-origin frame, and this is
accepted because artifacts are model-authored rather than adversarial
([`src/artifacts/verify-html.ts:92`](../../src/artifacts/verify-html.ts)). And
`skipRuntime` skips the second stage entirely for non-DOM contexts; only tests
pass it today.

## The sandbox

Two independent mechanisms contain an artifact, and neither is optional.

The **CSP** (`artifactCsp`,
[`src/artifacts/harness.ts:34`](../../src/artifacts/harness.ts)) is injected as
a `<meta http-equiv>` at the very start of `<head>`:

```text
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:;
base-uri 'none'; form-action 'none'
```

Inline JS and CSS run (and may `eval`), `data:`/`blob:` media loads, and
everything else is denied. `connect-src` falls back to `default-src 'none'`, so
there is no `fetch`, XHR or WebSocket.

The **iframe sandbox** is `allow-scripts` and never `allow-same-origin` — the
combination would hand the page the parent origin and undo the sandbox. That
pairing appears in three places and must stay identical in all of them:
verification
([`src/artifacts/verify-html.ts:48`](../../src/artifacts/verify-html.ts)), the
visible renderer
([`src/components/artifact/sandboxed-html-frame.tsx:111`](../../src/components/artifact/sandboxed-html-frame.tsx)),
and the real-browser test that asserts the harness protocol
(`e2e/artifact-harness.spec.ts`).

**The residual hole.** No clean CSP or sandbox token closes it: a script can
still navigate its own frame (`location = …`, a refresh meta), which issues an
outbound GET that no fetch directive sees. The rule that follows is absolute —
**never pass sensitive user-entered input into an artifact.** It is recorded at
[`src/artifacts/harness.ts:29`](../../src/artifacts/harness.ts); do not weaken
it without closing the hole first.

**Verification is a quality gate, not the security boundary.** The verdict is
persisted in the message and trusted on reload, and a remote producer verifies
wherever it runs (see below) — so the sandbox and the CSP are what actually
hold. The one security invariant tying the two together is that a visible
render only ever happens after verification, and both use the same
`wrapArtifactHtml`, so a page that somehow dodges the injection fails to send
`artifact-ready` and is rejected rather than shown without its CSP. Do not add
a render path that skips verification.

## The harness protocol

`wrapArtifactHtml(html, nonce)` splices the CSP meta tag and a small
error-reporting script into `<head>`, creating one if the document has none.
The harness is the first script in the document so it installs its listeners
before any model-authored code can throw or overwrite `window.onerror`.

It posts three message types to the parent, each carrying a per-render
`artifactNonce` so one page cannot spoof another render's result:
`artifact-ready`, `artifact-height`, and `artifact-error` (an exception or an
unhandled rejection). `parseHarnessMessage` is the single validator — it checks
both `event.source` and the nonce — so the verifier and the visible renderer
cannot drift apart.

Details that look arbitrary but are not:

- Failed subresource loads are ignored. A 404 image must not fail an otherwise
  working page, and the static check already rejects the blocked cases.
- Height is measured from `document.body.scrollHeight`, not
  `documentElement` — the root's is floored at the viewport height the parent
  just set, which would make the reported height monotonic and leave dead space
  under a shrinking artifact.
- `ResizeObserver` bursts are coalesced to one report per animation frame.
- The parent clamps the reported height to between 60 px and 20,000 px and
  ignores sub-pixel jitter, so a page that knows its own nonce cannot blow out
  the transcript
  ([`src/components/artifact/sandboxed-html-frame.tsx:11`](../../src/components/artifact/sandboxed-html-frame.tsx)).

There is a second wrapper, `wrapArtifactPreviewHtml`, which injects the CSP and
_no_ harness. It is used wherever scripts are off: the streaming preview, and
the downloaded `.html` file — so opening a downloaded artifact in a browser
still runs under the offline policy.

## Surfaces

An artifact is lifted out of the tool-call group and rendered on its own.
`groupMessageParts` does the lifting, gated on `artifactRendersStandalone`
([`src/lib/assistant-message.ts:53`](../../src/lib/assistant-message.ts)): a
call lifts out from the moment it starts and while it verifies, and only a
_finished_ call that failed — or errored — stays in the group as an ordinary
tool call.

`ArtifactMessagePart`
([`src/components/chat/artifact-message-part.tsx`](../../src/components/chat/artifact-message-part.tsx))
then picks one of three states:

| State                       | What renders                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| Streaming                   | An inline card with a live, **scripts-off** preview of the partial HTML |
| Verified, panel closed      | The interactive inline card                                             |
| Verified, open in the panel | A slim "shown in side panel" bar with a _Show inline_ button            |

An artifact exists in exactly one place at a time — inline or in the side
panel, never both. The panel is one of four open `ContentViewState` kinds
(`object-view`, `preview`, `sideview`, `artifact`, alongside a closed state —
[`src/content-view/context.tsx:37`](../../src/content-view/context.tsx)),
mounted by `main-layout.tsx` and rendered by
[`src/content-view/artifact-sidebar-content.tsx`](../../src/content-view/artifact-sidebar-content.tsx).
Both surfaces share `SandboxedHtmlFrame`, `ArtifactActions` (copy source,
download) and `ArtifactErrorStrip`, so a post-load runtime error looks the same
in either.

The streaming preview is throttled to 120 ms so token updates do not thrash the
iframe, and no frame appears at all until the partial HTML has something
renderable in `<body>`. Scripts are held back twice over: `useAppSettled`
delays the first artifact's scripts ~1 s so the initial page load finishes
first, and `useOnScreen` holds an artifact below the fold until it is scrolled
near. Both latch — flipping either back would reload the iframe and lose the
page's state.

## Who can produce one

Recognition is keyed on the tool **name** alone (`renderHtmlToolName`,
[`src/artifacts/constants.ts`](../../src/artifacts/constants.ts)), matched
against both typed `tool-<name>` parts and MCP `dynamic-tool` parts. Three
producers therefore reach the same frame:

- **The built-in agent**, whose `execute` runs the full verification in the
  browser.
- **Remote ACP agents.** The ACP layer forwards pi's whole `AgentToolResult` as
  `rawOutput`, so the `{ ok }` verdict arrives one level down under `details`.
  `renderHtmlOutput` reads both shapes; before it did, every hosted agent's
  artifact was stuck in the tool group as a plain tool call (#1286).
- **Any MCP server** exposing a tool called `render_html` that returns a
  matching verdict.

The widened producer set is safe only because the frame's guarantees do not
depend on who produced the HTML — the CSP and sandbox are applied by the
renderer, not by the tool.

## Projects, persistence, sync

Because an artifact is message content, it rides normal chat sync and needs no
table, no migration and no reconciliation. Projects use that: `useProjectArtifacts`
([`src/dal/projects.ts`](../../src/dal/projects.ts)) scans a project's messages
for `render_html` parts and lists them newest-first, narrowing with a
`parts LIKE '%render_html%'` filter before any JSON is parsed so a project with
thousands of ordinary messages does not pay to parse all of them. An artifact's
key is `messageId-index`, since one message can emit several calls and two can
share a title.

That query assumes message JSON is plaintext locally, which is called out as
untested under E2EE in [projects.md](./projects.md#known-gaps) — the same caveat
applies to the FTS index.

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
and `artifact-message-part.tsx`. The runtime path that happy-dom cannot
exercise — real script execution in a sandboxed iframe, the postMessage
protocol, and the CSP enforced in-engine — is covered by
`e2e/artifact-harness.spec.ts`.
