# Sample Finance App

A standalone Next.js app that doubles as a **Thunderbolt Mini App** — a remotely-hosted surface embedded in
Thunderbolt with a bidirectional bridge, so the assistant beside it can reason about whatever the user is looking at.

It runs perfectly well on its own. The Thunderbolt integration is additive: two files in `lib/` and a header in
`next.config.ts`.

## Running

```bash
bun install
bun dev          # http://localhost:5174
```

Then, in Thunderbolt:

1. Enable **Settings → Preferences → Preview Features → Mini Apps**.
2. Click **Finance Model** in the sidebar.
3. Use Thunderbolt's floating **Chat** button, highlight text for **Ask about this**, or hit **Select** to
   drag a box around several things at once.

## What a customer app has to do

Three things, in order of how likely each is to be the reason it doesn't work.

### 1. Send the right headers

Two of them, both set in `next.config.ts`. They fail identically — a blank panel, with nothing logged in the
embedding page — so check these before debugging anything else.

```ts
Content-Security-Policy: frame-ancestors 'self' http://localhost:1420 tauri://localhost http://tauri.localhost
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Resource-Policy: cross-origin
```

**`frame-ancestors`** — browsers refuse to render a frame whose CSP doesn't list the embedder, and Next.js sets no CSP
by default. `1420` is Thunderbolt's dev server (a Tauri convention, not Vite's usual 5173); the `tauri://` origins are
the desktop app on macOS and Windows.

**COEP + CORP** — Thunderbolt is _cross-origin isolated_: it sets `Cross-Origin-Embedder-Policy` because PowerSync's
wa-sqlite worker needs `SharedArrayBuffer`. A cross-origin iframe inside a COEP document has to opt in or it's blocked.
This isn't a Thunderbolt quirk — it applies to embedding in any cross-origin-isolated host, and it's the requirement
most teams haven't hit before.

### 2. Handshake

`lib/thunderbolt-bridge.ts` posts `initialize` to the parent window and waits for a reply. Until that completes,
Thunderbolt shows a connecting state and then an error — an app that never handshakes is indistinguishable from one
that isn't running.

The bridge is dependency-free and framework-agnostic; `lib/use-thunderbolt.ts` is a thin React wrapper over it. On
Vue or Svelte you'd copy only the former.

### 3. Publish context on every meaningful change

```ts
sendContext({
  title: 'FY26 Projection — Q3',
  summary: 'Prose written for a language model to read.',
  data: { assumptions, quarters },
  selection: focusedRow,
})
```

**The protocol is push-only.** Thunderbolt caches the last context you sent and serves it to the assistant on demand;
there is no pull. An app that forgets to publish will have the assistant confidently describing a stale view.

`summary` and `data` are deliberately separate. `summary` is prose you write for the model — it's where you say what
matters and what to notice. `data` is whatever structure you already have, forwarded without interpretation. Improving
how the assistant answers usually means improving `summary`, not reshaping `data`.

## Highlight to ask — free with the bridge

Select any text in the app and Thunderbolt floats an **Ask about this** control over the highlight.
Clicking it opens the chat and attaches the passage to the composer as a quote chip — the same chip you
get from replying to a message, so it removes cleanly and reaches the model as a real quote rather than
string-concatenated prose.

**The app writes no code for this.** `connect()` watches `selectionchange` and reports the text plus its
bounding rect over the bridge; Thunderbolt owns the control and everything downstream. Pass
`watchSelection: false` to opt out if your app has its own selection UI that would collide.

Selection is reported by the guest because a cross-origin host _cannot_ read the frame's selection —
that isolation is the point, so the app volunteers it. Reports are debounced until the selection
settles, and re-sent on scroll so the control doesn't strand itself.

## The Select tool — marquee, host-owned

Click **Select** and Thunderbolt dims the app and gives you a drag box, like a screenshot capture.
Release, and the covered items appear as chips in the composer.

The whole interaction lives in the host: it overlays the frame, captures the pointer, draws the dim and
the box, and owns the confirm step. Your app answers exactly one question, once, at the end —
_"what's inside this rectangle?"_ — via the `ui/selection-query` request. That split is deliberate: an app
that had to track hover and paint highlights itself would need real per-app work, and the Select tool
would look different in every Mini App.

`lib/selection-hit-test.ts` ships a generic default that works on any markup, so an app that does
nothing still gets usable results. Two ways to improve on it:

- **Mark your units.** Add `data-tb-select` (and optionally `data-tb-label`) to the elements that mean
  something — a table row, a card, a paragraph. The default prefers marked elements over guessing from
  tag names, so a box that roughly covers two rows snaps to exactly two rows.
- **Replace it.** Pass `resolveSelection` to `connect()` and return your own domain objects rather than
  scraped text. This is where an app can hand the model real structure.

The default snaps to _whole_ elements (60% coverage counts) and collapses nested matches to their
outermost ancestor — so a box over a table row yields the row, not the row plus each of its six cells.

## Tools — letting the assistant act, not just read

The app declares tools the model can call. This one exposes `set_assumption`, and that single tool is
what makes the demo work:

> _"What growth rate keeps Q4 operating margin above 20%?"_

The model sets growth to 8%, reads the recomputed model back through `get_app_context`, sets 14%, reads
again, and converges. Goal-seek isn't a tool — it falls out of write-then-read in a loop, which is why
one small tool beats one clever one.

```ts
const tools: ThunderboltTool[] = [
  {
    name: 'set_assumption',
    description: 'Change one input of the model and recompute…',
    inputSchema: { type: 'object', properties: {/* JSON Schema */}, required: ['key', 'value'] },
    annotations: { readOnlyHint: false, title: 'Change a model assumption' },
    execute: ({ key, value }) => {
      /* … */
    },
  },
]

const { connected } = useThunderbolt('Finance Model', tools)
```

**`readOnlyHint` decides whether the user is asked.** Read-only tools run silently; everything else
shows an approval prompt in Thunderbolt with the tool, its description, and the exact arguments. An
omitted annotation means "ask" — and the _host_ enforces this from the descriptor it received, so an
app that lies can only ever cause an extra prompt, never skip one.

Return the consequence rather than an acknowledgement (`"Set growthRate to 9. Q4 operating income is
now $1.2M…"`) — it saves the model a round trip while it's iterating.

### Why not WebMCP?

Because Thunderbolt has to run where WebMCP doesn't. Its desktop app is Tauri, which embeds WKWebView
on macOS and WebKitGTK on Linux — both WebKit, neither implements it. Chrome's support is a
time-boxed origin trial (149→156) of a W3C _Community Group_ draft, not a standards-track API, and it
has already renamed its entry point once. Mozilla is neutral; Safari hasn't committed.

So `ThunderboltTool` is deliberately **WebMCP's descriptor**, field for field. If you already register
tools with `document.modelContext.registerTool`, hand us the same objects — `toWebMcpTools()` in
`lib/thunderbolt-tools.ts` goes the other way in about ten lines. And if WebMCP ships broadly,
Thunderbolt feature-detects it and prefers it, without your tool definitions changing.

The transport underneath is JSON-RPC 2.0 using MCP's own method names, `tools/list` and `tools/call`.

## Protocol

JSON-RPC 2.0 over `postMessage`, marked with `protocol: 'thunderbolt-miniapp'`.

Method names follow **MCP Apps** where the semantics match (`ui/initialize`, `ui/update-model-context`, and MCP's own
`tools/*`); `ui/open-chat` and the selection pair are Thunderbolt extensions with no MCP Apps equivalent. We don't
implement MCP Apps itself — it ships UI as an HTML string into a sandbox proxy, which leaves the app with no origin
of its own, and therefore no cookies, no same-origin calls to its backend and nowhere for an OIDC redirect to land.

| Direction  | Method                               | Kind         | Purpose                                                          |
| ---------- | ------------------------------------ | ------------ | ---------------------------------------------------------------- |
| app → host | `ui/initialize`                      | request      | Handshake; exchanges protocol version and capabilities           |
| app → host | `ui/update-model-context`            | notification | Publish the current view                                         |
| app → host | `ui/notifications/selection-changed` | notification | Text selected or cleared (auto-wired by `connect()`)             |
| app → host | `ui/open-chat`                       | request      | Ask the host to open its chat panel, optionally seeding a prompt |
| host → app | `ui/notifications/theme-changed`     | notification | Host appearance changed                                          |
| host → app | `ui/selection-query`                 | request      | "What's inside this rect?" — answered by `resolveSelection`      |
| host → app | `tools/list`                         | request      | Discover declared tools (MCP method name)                        |
| host → app | `tools/call`                         | request      | Invoke one (MCP method name)                                     |

Both sides pin origins: the app only accepts messages from the host origin it was configured with, and the host only
accepts messages from the origin registered for the app. Neither uses `postMessage(..., '*')`.

## Layout

```
app/page.tsx              the model UI
lib/model.ts              projection math + the model-facing summary
lib/thunderbolt-bridge.ts the bridge (framework-free — this is the portable part)
lib/selection-hit-test.ts default marquee hit-test (override via resolveSelection)
lib/thunderbolt-tools.ts  tool descriptors (WebMCP-shaped) + why not WebMCP directly
lib/use-thunderbolt.ts    React binding over the bridge
next.config.ts            frame-ancestors
```

## Troubleshooting

In rough order of how likely each is.

**"Couldn't reach Finance Model" in the panel.** The handshake never completed within 8s. Almost always
the port: `next dev` **silently moves to 5175 if 5174 is taken** and just warns in the terminal, while
Thunderbolt is still pointed at 5174. Check the terminal output first.

If you genuinely need a different port, it's hard-coded in three places:

| Where                                     | What                       |
| ----------------------------------------- | -------------------------- |
| `package.json`                            | `next dev -p 5174`         |
| `src/mini-apps/registry.ts` (Thunderbolt) | `url` **and** `origin`     |
| `src-tauri/tauri.conf.json` (Thunderbolt) | `frame-src` — desktop only |

`origin` is checked separately from `url` on purpose, so both have to change.

**Blank panel, nothing in the console.** A header is missing — see _Send the right headers_ above. This
fails without an error in the embedding page, which is why it's worth ruling out early.

**No "Finance Model" in the sidebar.** Enable **Settings → Preferences → Preview Features → Mini Apps**.
It's a synced setting, so it's per-account rather than per-machine.

**Works in the browser, blank in the desktop app.** `frame-src` lives in `tauri.conf.json` and is
compiled in at startup — a reload won't pick it up. Quit and relaunch.

**The chat answers but ignores the app.** Check the model actually called `get_app_context`. If it
answered from the prompt alone it will sound confident and be wrong. The tool is only registered while a
Mini App route is mounted.

**Running it standalone is fine.** Open http://localhost:5174 directly and you'll see the model with a
"Standalone" badge and no assistant. That's correct — the bridge rejects when there's no parent frame,
and the app is designed to stay fully usable without Thunderbolt.
