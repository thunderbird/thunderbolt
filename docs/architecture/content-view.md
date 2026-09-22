# The Content View

The **content view** is the panel beside the chat — the one that opens when you click a tool
result, a citation, an attachment, a link, or an artifact. It is a single slot with a single
state machine: four kinds of content can appear in it, exactly one at a time, and opening one
replaces whatever was there.

That exclusivity is the design, not an accident of implementation. There is one panel in the
window, so there is one piece of state describing what is in it
([`src/content-view/context.tsx:37`](../../src/content-view/context.tsx)):

```ts
type ContentViewState =
  | { type: null; data: null }
  | { type: 'object-view'; data: ObjectViewData }
  | { type: 'preview'; data: SidebarWebviewConfig }
  | { type: 'sideview'; data: SideviewData }
  | { type: 'artifact'; data: ArtifactViewData }
```

Each kind carries its own payload, so a consumer that narrows on `state.type` gets the right
data shape for free and there is no way to be in "preview mode with artifact data". Opening a
sideview over an open object view is a tested transition, not an edge case
([`context.test.tsx:128`](../../src/content-view/context.test.tsx)).

## The four kinds

| Kind          | Opened by                                                                                                                                      | Rendered by                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `object-view` | `showObjectView` — a tool call or reasoning part in the transcript ([`reasoning-group.tsx:99`](../../src/components/chat/reasoning-group.tsx)) | `object-sidebar-content.tsx`   |
| `preview`     | `showPreview(url)` — a link in an assistant message ([`markdown-utils.tsx:209`](../../src/components/chat/markdown-utils.tsx))                 | `sidebar-webview.tsx`          |
| `sideview`    | `showSideview(type, id)` — a document citation, a document-result widget, or a sent attachment                                                 | `sideview.tsx`                 |
| `artifact`    | `showArtifact(data)` — the "open in panel" control on an inline artifact card                                                                  | `artifact-sidebar-content.tsx` |

`object-view` flattens its input at open time: a reasoning part becomes `{ title, output }`
with the localized title resolved eagerly through the `i18n` singleton (the stored string is a
snapshot, so it deliberately does not follow a later language change — see the module-scope
rule in [AGENTS.md](../../AGENTS.md#module-scope-freezes-the-locale)), and a tool part resolves
its title from curated metadata or, for an MCP `dynamic-tool` part, from the message's tool
map. A failed call shows `errorText` rather than an empty output.

`artifact` holds the HTML plus the originating `render_html` tool-call id, which is what lets
the transcript know its artifact is the one currently in the panel and swap itself for a
placeholder. The artifact pipeline — the tool, verification, the sandbox and the harness — is
[its own document](./artifacts.md); this one only owns the panel slot.

`sideview` is the only kind whose payload is untyped on purpose: a `sideviewType` string and a
`sideviewId` string. Ids are built and parsed by `buildDocumentSideviewId` /
`parseDocumentSideviewId` ([`src/types/citation.ts:48`](../../src/types/citation.ts)), which
encode `fileId:fileName[:pageNumber]` and treat only a trailing all-digit segment as the page,
because filenames can contain colons.

## The host layout

`main-layout.tsx` is the only mount point
([`src/layout/main-layout.tsx:93`](../../src/layout/main-layout.tsx)). It renders the same
`contentView` fragment into two different containers:

- **Desktop** — a collapsible `ResizablePanel` beside the chat. Width is animated from 0 to the
  target on open and back to 0 on close; dragging the handle all the way to zero calls `close()`,
  so the panel state can never disagree with what is on screen.
- **Mobile** — a full-screen `Dialog`. There is no resizable panel at all below the breakpoint.

Panel width is persisted as the `content_view_width` setting (default `50`, meaning 50 % of the
window — [`src/defaults/settings.ts:190`](../../src/defaults/settings.ts)), written only on
desktop: while dragging, once the change exceeds one percentage point, and once more with the
final size as the panel closes. `settings` is a synced table, so the width follows the account.
On open, a saved width below `minimumWidthThreshold` (10 %) is ignored in favor of
`defaultOpenWidth` (50 %) — reopening into a two-pixel sliver reads as a
bug, so a near-collapsed width is treated as "no preference"
([`src/content-view/constants.ts:19`](../../src/content-view/constants.ts)).

`ContentViewHeader` ([`src/content-view/header.tsx`](../../src/content-view/header.tsx)) is the
shared chrome: title, optional actions, close button. Its awkward-looking padding rules are
window-chrome clearance, not taste — at mobile width the panel fills the window and its header
lands under the macOS traffic lights, and when open on desktop it occupies the top-right corner
where the frameless Windows/Linux caption buttons live. In the desktop app the header also
doubles as a drag region, like every other header strip.

`object-view`, `artifact` and `preview` render the header themselves. A **sideview does not** —
`Sideview` renders only the viewer, and the viewer supplies its own header and calls `close()`
from the context ([`pdf-sidebar-viewer.tsx:87`](../../src/widgets/document-result/pdf-sidebar-viewer.tsx)).
A new sideview kind that forgets this renders with no close affordance on desktop (the mobile
dialog supplies its own).

## The preview mode is not a DOM node

Everything else in the panel is React. `preview` is a second native Tauri `Webview`, attached to
the app window with `new Webview(getCurrentWindow(), …)` and positioned over the panel's bounding
rect ([`use-sidebar-webview.ts`](../../src/content-view/use-sidebar-webview.ts)). Three consequences
follow, and all three have code you would otherwise be tempted to delete:

- **It paints over DOM siblings.** Nothing rendered by React can appear on top of it. When the
  external-link confirmation dialog opens it therefore sets `previewHidden`, which hides the
  native webview for the duration, and resets it on unmount
  ([`markdown-utils.tsx:222`](../../src/components/chat/markdown-utils.tsx)). This is the only
  consumer of `previewHidden`; the flag exists for that one collision.
- **It covers the resize handle.** `main-layout.tsx:148` renders a transparent strip over the
  handle's right half in preview mode purely so the cursor stays `default` instead of promising
  a drag that will not happen.
- **Its position is computed, not laid out.** `previewHeaderHeight` (48) must match the desktop
  header's `h-12`, and `coordinateOffset` (28) is an empirically determined title-bar offset in
  Tauri's coordinate system ([`constants.ts:10`](../../src/content-view/constants.ts)). Change
  the header's height and the webview overlaps it or leaves a gap — there is no layout engine
  to catch it.

Outside Tauri the component renders a "only available in the desktop app" message rather than
an empty frame. The privacy trade-offs of running third-party pages in an embedded webview
(incognito by default, IP exposure, no extensions) are covered in
[features/webview.md](../features/webview.md).

## Consuming the context

`useContentView()` throws outside the provider. The narrow accessors — `useShowPreview`,
`useShowSideview`, `useSetPreviewHidden` — return `undefined` instead, and callers branch on
that. This is what lets chat components render in contexts with no panel at all: link handling
computes `desktop = isDesktopPlatform() && !!showPreview` and falls back to the confirmation
dialog, and attachment cards omit the open affordance rather than crashing
([`message-bubbles.tsx:66`](../../src/components/chat/message-bubbles.tsx)). The link path has a
regression test for it — "works without ContentViewProvider" in
[`markdown-utils.test.tsx`](../../src/components/chat/markdown-utils.test.tsx).

The provider is mounted once in `app.tsx` ([`src/app.tsx:372`](../../src/app.tsx)), wrapping
`ExternalLinkDialogProvider` (which depends on it) and sitting above the `BrowserRouter` inside
`AppContent`, so panel state survives navigation. It takes an injectable `trackEvent` so the
analytics assertions in its tests do not need a PostHog client. Every open emits
`content_view_open` with a `view_type`, and `close()` emits `content_view_close` — but only when
something was actually open.

## Adding to it

**A new sideview kind** — add a branch to the switch in
[`sideview.tsx:31`](../../src/content-view/sideview.tsx), lazy-load the viewer if it pulls in a
heavy dependency (the PDF path defers react-pdf and pdfjs this way; its DOCX branch defers
mammoth one level further, in the shared
[`docxToHtml`](../../src/files/transformers/docx-to-html.ts) transformer), render a
`ContentViewHeader` in the viewer, and call `showSideview('<your-type>', id)` from the trigger.
No context change is needed — `sideviewType`
is a plain string precisely so a new kind stays local to these two edits.

**A whole new kind** is the heavier change: extend the `ContentViewState` union and the context
type, add a `showX` action that emits `content_view_open`, and add the render branch in
`main-layout.tsx`. Reach for it only when the payload genuinely cannot be expressed as a
sideview id — a sideview is a type string and an id, so anything addressable by identity
belongs there.

## Where the code lives

| Path                                            | Role                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `src/content-view/context.tsx`                  | The state machine, actions, and the hook surface            |
| `src/content-view/constants.ts`                 | Layout constants shared with the native webview positioning |
| `src/content-view/header.tsx`                   | Shared panel chrome and window-controls clearance           |
| `src/content-view/object-sidebar-content.tsx`   | Tool-call / reasoning output view                           |
| `src/content-view/artifact-sidebar-content.tsx` | Artifact panel view                                         |
| `src/content-view/sideview.tsx`                 | Sideview kind switch                                        |
| `src/content-view/sidebar-webview.tsx`          | Preview chrome around the native webview                    |
| `src/content-view/use-sidebar-webview.ts`       | Native webview lifecycle, positioning, and teardown         |
| `src/layout/main-layout.tsx`                    | The only mount point; panel vs. dialog, width persistence   |

## Further reading

- [HTML Artifacts](./artifacts.md) — the `render_html` pipeline behind the `artifact` kind.
- [Attachments](./attachments.md) — how a sent file reaches the `local-file` sideview.
- [WebView](../features/webview.md) — the privacy and platform story for `preview`.
