# The Content View

The panel beside the chat, opened by a tool result, a citation, an attachment, a link, or an
artifact. One slot, four kinds of content, one at a time: opening one replaces whatever was there.

## The four kinds

| Kind          | Opened by                                                                                                                          | Rendered by                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `object-view` | `showObjectView`, from a tool call or reasoning part ([`reasoning-group.tsx:99`](../../src/components/chat/reasoning-group.tsx))   | `object-sidebar-content.tsx`   |
| `preview`     | `showPreview(url)`, from a link in an assistant message ([`markdown-utils.tsx:209`](../../src/components/chat/markdown-utils.tsx)) | `sidebar-webview.tsx`          |
| `sideview`    | `showSideview(type, id)`, from a document citation, a document-result widget, or a sent attachment                                 | `sideview.tsx`                 |
| `artifact`    | `showArtifact(data)`, from the "open in panel" control on an inline artifact card                                                  | `artifact-sidebar-content.tsx` |

State is a discriminated union, so "preview mode with artifact data" is unrepresentable
([`src/content-view/context.tsx:37`](../../src/content-view/context.tsx)):

```ts
type ContentViewState =
  | { type: null; data: null }
  | { type: 'object-view'; data: ObjectViewData }
  | { type: 'preview'; data: SidebarWebviewConfig }
  | { type: 'sideview'; data: SideviewData }
  | { type: 'artifact'; data: ArtifactViewData }
```

Swapping one kind for another is a tested transition, not an edge case: `showSideview` over an
open object view ([`context.test.tsx:128`](../../src/content-view/context.test.tsx)).

### What each kind carries

- **`object-view`** flattens its input at open time: a reasoning part becomes `{ title, output }`, a
  tool part takes its title from curated metadata (or the message's tool map for an MCP
  `dynamic-tool` part), and a failed call shows `errorText`. Titles resolve eagerly through the
  `i18n` singleton, so the stored string is a snapshot and does not follow a later language change
  ([AGENTS.md](../../AGENTS.md#module-scope-freezes-the-locale)).
- **`artifact`** holds the HTML plus the originating `render_html` tool-call id, so the transcript
  can swap its own card for a placeholder. The pipeline behind it is
  [its own document](./artifacts.md).
- **`sideview`** carries two untyped strings on purpose, `sideviewType` and `sideviewId`.
  `buildDocumentSideviewId` / `parseDocumentSideviewId`
  ([`src/types/citation.ts:48`](../../src/types/citation.ts)) encode `fileId:fileName[:pageNumber]`;
  only a trailing all-digit segment counts as the page, because filenames can contain colons.

## Where it mounts

The only mount point ([`src/layout/main-layout.tsx:93`](../../src/layout/main-layout.tsx)) renders
the same `contentView` fragment into two containers:

| Platform | Container                                    | Notes                                                                                                                                                |
| -------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop  | collapsible `ResizablePanel` beside the chat | Width animates 0 → target on open and back on close. Dragging the handle to zero calls `close()`, so panel state can never disagree with the screen. |
| Mobile   | full-screen `Dialog`                         | No resizable panel at all below the breakpoint.                                                                                                      |

### Panel width

- `content_view_width` setting, default `50` (% of the window,
  [`src/defaults/settings.ts:190`](../../src/defaults/settings.ts)). `settings` is synced, so the
  width follows the account.
- Written on desktop only: while dragging, once the change exceeds one percentage point, and once
  more with the final size on close.
- On open, a saved width below `minimumWidthThreshold` (10 %) yields to `defaultOpenWidth` (50 %)
  ([`src/content-view/constants.ts:19`](../../src/content-view/constants.ts)): a near-collapsed width
  counts as "no preference" rather than reopening into a sliver.

### Who renders the header

`ContentViewHeader` ([`src/content-view/header.tsx`](../../src/content-view/header.tsx)) is the
shared chrome: title, optional actions, close button. `object-view`, `artifact` and `preview` render
it themselves.

**A sideview does not.** The viewer supplies its own header and calls `close()`
([`pdf-sidebar-viewer.tsx:87`](../../src/widgets/document-result/pdf-sidebar-viewer.tsx)). A new
sideview kind that forgets this has no close affordance on desktop; the mobile dialog supplies its
own.

The header's padding is window-chrome clearance: at mobile width the panel fills the window and the
header lands under the macOS traffic lights; open on desktop it occupies the top-right corner where
the frameless Windows/Linux caption buttons live. In the desktop app it also doubles as a drag
region, like every other header strip.

## Why `preview` is not a DOM node

Everything else in the panel is React. `preview` is a second native Tauri `Webview`, attached with
`new Webview(getCurrentWindow(), …)` and positioned over the panel's bounding rect
([`use-sidebar-webview.ts`](../../src/content-view/use-sidebar-webview.ts)). Three consequences,
each with code you would otherwise delete:

- **It paints over DOM siblings.** The external-link confirmation dialog sets `previewHidden` for
  its duration and resets it on unmount
  ([`markdown-utils.tsx:222`](../../src/components/chat/markdown-utils.tsx)); that is the flag's only
  consumer.
- **It covers the resize handle.** `main-layout.tsx:148` puts a transparent strip over the handle's
  right half in preview mode so the cursor stays `default` rather than promising a drag.
- **Its position is computed, not laid out.** `previewHeaderHeight` (48) must match the desktop
  header's `h-12`; `coordinateOffset` (28) is an empirical title-bar offset in Tauri's coordinate
  system ([`constants.ts:10`](../../src/content-view/constants.ts)). Change the header height and
  the webview overlaps it or leaves a gap, with no layout engine to catch it.

Outside Tauri the component renders a "only available in the desktop app" message. Privacy
trade-offs (incognito by default, IP exposure, no extensions): [webview.md](../features/webview.md).

## Consuming the context

| Hook                                                       | Outside the provider |
| ---------------------------------------------------------- | -------------------- |
| `useContentView()`                                         | throws               |
| `useShowPreview`, `useShowSideview`, `useSetPreviewHidden` | return `undefined`   |

Callers branch on `undefined` so chat components render where there is no panel: link handling
computes `desktop = isDesktopPlatform() && !!showPreview` and falls back to the confirmation dialog,
and attachment cards drop the open affordance
([`message-bubbles.tsx:66`](../../src/components/chat/message-bubbles.tsx)). Regression test: "works
without ContentViewProvider" in
[`markdown-utils.test.tsx`](../../src/components/chat/markdown-utils.test.tsx).

**Mounting:** once in `app.tsx` ([`src/app.tsx:372`](../../src/app.tsx)), wrapping
`ExternalLinkDialogProvider` (which depends on it) and above the `BrowserRouter` inside
`AppContent`, so panel state survives navigation. `trackEvent` is injectable, so its tests need no
PostHog client.

**Analytics:** each open emits `content_view_open` with a `view_type`; `close()` emits
`content_view_close` only when something was open.

## Adding to it

**A new sideview kind:** add a branch to the switch in
[`sideview.tsx:31`](../../src/content-view/sideview.tsx), lazy-load the viewer if it pulls in a heavy
dependency, render a `ContentViewHeader` in it, and call `showSideview('<your-type>', id)` from the
trigger. `sideviewType` is a plain string so a new kind needs no context change. (The PDF path
defers react-pdf and pdfjs; its DOCX branch defers mammoth inside the shared
[`docxToHtml`](../../src/files/transformers/docx-to-html.ts) transformer.)

**A whole new kind:** extend the `ContentViewState` union and the context type, add a `showX` action
that emits `content_view_open`, and add the render branch in `main-layout.tsx`. Only when the payload
cannot be expressed as a sideview id: anything addressable by identity belongs in a sideview.

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

- [HTML Artifacts](./artifacts.md): the `render_html` pipeline.
- [Attachments](./attachments.md): how a sent file reaches the `local-file` sideview.
- [WebView](../features/webview.md): privacy and platform story for `preview`.
