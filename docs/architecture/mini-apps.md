# Mini Apps

A Mini App is a customer's web app, deployed at its own URL, embedded in Thunderbolt as a first-class page with a
bridge so the assistant beside it can read and act on what the user is looking at.

The point is to keep the core generic. Onboarding a customer app should be a config entry, not a code change — and
the day an app needs something we don't have, the fix belongs in the protocol, not in a special case here.

## Three ways to put something on screen, and what each costs

These look similar from a distance and get conflated constantly. They are not alternatives to each other; only two
of them are UI transports, and only one gives the app an origin of its own.

|                      | Who provides the UI              | Rendered how               | App has its own origin?   |
| -------------------- | -------------------------------- | -------------------------- | ------------------------- |
| **WebMCP**           | Nobody — the page already exists | Browser, top-level         | Yes (it's just a website) |
| **MCP Apps**         | The MCP server, as `ui://` HTML  | Host, into a sandbox proxy | **No**                    |
| **Mini Apps** (ours) | The customer's deployed app      | Host, `<iframe src>`       | **Yes**                   |

### Why not MCP Apps

MCP Apps (SEP-1865, January 2026) is the first official MCP extension and its wire shape is nearly identical to
ours: JSON-RPC over `postMessage`, sandboxed frame, UI-initiated tool calls through the host's consent path. We
took its method names where the semantics match. We did not take its delivery model, for three reasons that are
each independently fatal here:

1. **External URLs are prohibited** in the MVP — only `ui://` resources with `text/html;profile=mcp-app`.
2. **The lifecycle is a widget**, created around one tool call and torn down after. State persistence is
   explicitly deferred. Our apps are routes the user navigates within.
3. **No origin.** Web hosts must use a two-iframe sandbox proxy, with the inner frame receiving raw HTML over
   `postMessage`. So the app never runs on its own domain: no cookies, no same-origin calls to its own backend,
   nowhere for an OIDC redirect to land. Everything in the identity design below becomes impossible.

External URL support is deferred rather than rejected. If it lands with a real origin, revisit — that is the
trigger, not a general sense that we should be closer to the standard.

### Why not WebMCP — and why we ship it anyway

WebMCP has no UI transport at all, and never will: it assumes the page is already on screen and only lets it
declare tools. It can replace `tools/list` + `tools/call` and nothing else — not context reads, selection,
theme, or chat-open. So it cannot be the protocol.

It is, however, the right **API**, and since THU-910 it is the one app authors write against. The SDK installs a
`document.modelContext` shim at import (`miniapps/sdk/src/model-context.ts`) and the bridge answers `tools/list`
and `tools/call` out of whatever registry is there:

| The browser has                      | What the SDK does                                           |
| ------------------------------------ | ----------------------------------------------------------- |
| Native `document.modelContext`       | Uses it, unmodified, and reads tools back with `getTools()` |
| Nothing                              | Installs a shim with the same shape                         |
| Something else claiming the property | Leaves it alone, warns, and uses a detached registry        |

Native is never reassigned. Overwriting it would silently drop every tool registered by code that has never heard
of Thunderbolt — another SDK on the page, or the app's own pre-existing WebMCP support — and the app author would
have no way to see why. The shim carries a `Symbol.for` brand so we can tell our own installation from the
browser's, which duck-typing cannot do: the shim satisfies the interface, so it answers every check native would.

The frame's `allow` attribute stays **empty**, `tools` included. That feature is not how the host reads tools — it
reads them from inside the frame over the bridge. What `allow="tools"` grants is cross-frame discovery by an agent
in the _embedder_, which in a Thunderbolt window means the browser's agent, not ours: it would route a customer
app's tools around the approval prompt `readOnlyHint` gates, to a caller we have no relationship with.

Two spellings reach the same registry, and which one to use is about the framework, not about portability:

```ts
// Canonical, portable, and what a non-React app should write.
document.modelContext.registerTool({
  name: 'set_assumption',
  description: 'Change one input of the model.',
  inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
  execute: ({ key }) => ({ content: [{ type: 'text', text: `Set ${key}.` }] }),
})

// The `tools` option — same descriptor, `execute` returns a plain string.
useThunderbolt('Finance Model', tools, { getContext })
```

The samples use the option, deliberately. A React `execute` closes over current state, so the array is rebuilt
every render and the bridge re-resolves it per call; the equivalent `registerTool` is an effect that re-registers
on every keystroke, which is a worse example, not a more modern one. Non-React apps have no such pull and should
use `registerTool`.

Registering after the handshake is normal — an effect runs later than `ui/initialize`, so the `tools` capability
could not have been declared. The guest sends `ui/notifications/tools-changed` (WebMCP's `toolchange` event,
forwarded) and the host re-runs `tools/list`. The notification carries no descriptors: making it a prompt to ask
again rather than a push keeps `parseToolsList` the only way a tool ever enters the host, caps and all. The host
honours 20 of them per document, which is far above real use and bounds what a guest stuck in a
register/unregister loop can cost.

Its other natural home in Thunderbolt is the **native webview** (`src/content-view/sidebar-webview.tsx`), which
loads arbitrary third-party sites that refuse to be iframed — the same shape as ChatGPT desktop's built-in
browser, which shipped WebMCP support in August 2026. That's also where the constraint bites: Tauri is WKWebView
on macOS and WebKitGTK on Linux, and neither implements `document.modelContext`. Only Windows (WebView2) could.

## Surfaces: one embed path

**Decision: the iframe path covers every surface.** The native webview is a different feature, for a different
problem.

Mini Apps are _cooperative_ — they send `frame-ancestors` naming us — so a plain `<iframe src>` works everywhere,
and gives us `postMessage` for free. The native webview exists for arbitrary sites that send `X-Frame-Options`,
which no Mini App does.

| Surface               | Embed  | Open                                                                                             |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| Web (desktop browser) | iframe | —                                                                                                |
| Tauri desktop         | iframe | `frame-src 'self' https:` — any HTTPS app origin loads; see below for why it is not an allowlist |
| Tauri iOS / Android   | —      | not offered — the viewport gate below catches these                                              |
| Mobile web            | —      | not offered — same gate                                                                          |

**Mini Apps are web and desktop only** (THU-830). The gate is on _viewport_, not platform: the split view,
highlight-to-ask and element picking all need pointer input and room, and a 700px browser window is as unworkable as a
phone. `useIsMobile` exempts the Tauri desktop app at any width, so narrowing the desktop window keeps the feature
while narrowing a browser does not.

Below the breakpoint the sidebar entry is hidden and the route renders a size notice rather than disappearing — a
deep link out of a synced chat, or someone narrowing their window mid-session, is told what happened instead of
hitting Not Found. An earlier cut overlaid the chat on the app for phones; that layout is gone, so nothing here
depends on iOS Safari's COEP support being confirmed.

**The desktop CSP allows any HTTPS origin to be framed, and deliberately does not name them.** Tauri compiles its
CSP in at startup while the registry moved to runtime config (`MINI_APPS`), so the two cannot be reconciled: a
build-time allowlist means a new desktop build for every new customer origin, and a reload would not pick up a
change. `frame-src 'self' https:` is the compromise.

This had been left out entirely, which meant frames fell back to `default-src` (`'self' tauri: asset:`) and **no app
loaded in a desktop build at all** — the feature was unusable on desktop. The directive had been removed because it
named sample-app _localhost_ origins in production builds, which was the right call about the wrong thing: the
problem was the localhost origins, not the directive. Production now allows `https:` and no localhost;
`tauri.dev.conf.json` adds the dev ports on top.

What that does and does not buy, stated plainly:

- It is **not** the trust boundary for anything an app says. The bridge pins the origin in both directions — it
  posts to `app.origin` and drops any message whose `event.origin` is not that app's — and those checks are what
  make a guest's messages trustworthy. `frame-src` only decides what may be _framed_.
- A framed page still cannot reach into Thunderbolt: `script-src` and `default-src` stay locked to `'self'`, so the
  browser's origin model contains it.
- It is consistent with the posture already in place rather than a loosening of it: `connect-src` in the same CSP
  already allows `https:` and `wss:`.
- What it gives up is defence in depth against a compromised renderer framing an origin the operator never
  configured. That is a strictly smaller threat than the registry itself, which decides what gets framed.

A generated allowlist is still the better answer once `MINI_APPS` is known at build time for a given deployment.

## Chrome around an app

The shared header appears on an app route only where it has something in it. Everything the header normally carries
— the agent selector, the project badge — is gated on being a `/chats` route, so on the web it renders an empty bar
plus its scrim above an app that then cannot reach the top of the window. What survives on an app route is platform
chrome: back/forward and the frameless drag region in the desktop app, and the sidebar toggle on a collapsed macOS
window.

So: **no header over the app on the web, header in the desktop app.** One predicate decides it,
`sharedHeaderHasControls` — `main-layout` uses it to draw the header and the app route uses it to reserve the room,
and they must not disagree or the app slides under the scrim. Removing the header outright was tried first and cost
exactly those controls, which is why it came back.

The chat panel keeps its own header, inside its pane: it holds that conversation's controls (new chat, history,
close) and the window-control clearances a right-hand pane needs.

## Running one locally

There is nothing to switch on. An app appears in the sidebar as soon as the backend registers it, on a viewport
wide enough for the split view.

```sh
# 1. an app to embed — the starter template, which is what MINI_APPS defaults to in development
git clone git@github.com:thunderbird/thunderbolt-miniapp-template.git
cd thunderbolt-miniapp-template && bun install && bun dev     # serves on :5190

# 2. Thunderbolt, in another terminal
bun run dev                                                   # web, on :1420
bun run tauri:dev:desktop                                     # or the desktop app
```

"Order Book" appears under Apps in the sidebar. If it doesn't, in order: is the template actually up on :5190; did
you restart the **backend** after touching `MINI_APPS` (`getSettings()` memoizes per process); and is the window
wide enough (below the breakpoint the entry is hidden and the route shows a size notice).

Registering something else means editing `MINI_APPS` — see the block in `backend/.env.example`. Two things bite:

- **A desktop dev build needs the origin in its CSP**, and Tauri compiles that in at startup.
  `src-tauri/tauri.dev.conf.json` allows the sample ports (`:5190`, `:5174`, `:5180`) plus `https:`; another local
  port means adding it there and restarting. Packaged builds allow any `https:` origin and no localhost — see the
  CSP section above for why it is not an allowlist.
- **The app must send the three embedding headers** or the panel stays blank with nothing in the console. The
  template already does; see "The embedding headers".

## Registry and configuration

One config, `MINI_APPS` on the backend, keyed by app id. The frontend reads it over `GET /mini-apps` with secrets
stripped; the token route signs with them.

It is deliberately not two configs. An earlier cut kept presentation in a frontend array and only the audience on
the backend, which meant two lists of the same apps that could disagree — and the failure was silent: an app the
backend didn't know about rendered in the sidebar, loaded fine, and then couldn't authenticate.

`origin` stays separate from `url` rather than derived. A redirect can move `url`, and the value we validate
inbound messages against must be the one an operator declared, not one the app can influence.

It's also not a settings panel, despite the pull. A registry entry carries a signing secret and an origin that
CSP will allow, which makes it deployment config rather than user preference — and Thunderbolt has no admin role
to scope it to. Per-user preferences over those apps (hide, reorder) would be fine in settings; the registry
itself would not.

## The three-party interface: model, Thunderbolt, app

Three parties, and it matters which pair is talking, because they trust each other differently.

```
   model  ←──── tools + prompt ────→  Thunderbolt  ←──── JSON-RPC / postMessage ────→  app
(untrusted output)                  (the only party           (untrusted input,
                                     that trusts anyone)       a different origin)
```

The model never touches the app, and the app never touches the model. Everything crosses through Thunderbolt,
which is the only place a decision gets made. Both outer parties are untrusted: an app is third-party code on a
different origin, and a model's output is influenced by whatever it just read — including, possibly, text the app
supplied.

### What the app tells Thunderbolt

Everything the guest can say, all guest-initiated and all optional:

| It says                              | When                                          | Reaches the model as                        |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------- |
| `ui/initialize`                      | Once per document, with a `documentId`        | Nothing. Capability negotiation only        |
| `ui/identify` (host → app)           | After every frame `load`                      | Nothing. Decides whose handshake is live    |
| `ui/get-context` (host → app)        | On every `get_app_context` call               | The `get_app_context` tool's return value   |
| `tools/list` (as a reply)            | After handshake, and on every `tools-changed` | Tool definitions, prefixed `app_`           |
| `ui/notifications/tools-changed`     | When its tool registry moves                  | Nothing directly. Host re-runs `tools/list` |
| `ui/notifications/error`             | On an uncaught error                          | Nothing. Host UI only                       |
| `ui/notifications/selection-changed` | When the user selects text in the app         | Nothing until the user asks about it        |
| `ui/open-chat`                       | When the app wants the panel open             | Nothing. Seeds the composer for the user    |
| `ui/request-auth-token`              | When its identity token is near expiry        | Nothing. Host mints and replies             |

Note what's **absent**: there is no way for an app to send text directly to the model, or to make the model say
something. `ui/open-chat` can seed the _composer_ with a prompt, which the user then reads and chooses to send —
a suggestion to the user, not an instruction to the model.

### What Thunderbolt tells the model

Two channels, and the distinction is the whole design:

**The system prompt** carries the app's _identity_ — its name and the description from `MINI_APPS`. Operator-authored,
so it's trusted, and it's stable for the turn, which keeps the cached prefix intact. The app's own tool
descriptions also ride here, capped and fenced in `<app-provided-tool-list>` (see [Descriptor limits](#descriptor-limits)).

**Tool calls** carry the app's _state_, on demand:

- `get_app_context` asks the frame over `ui/get-context` and returns what it answers _now_; on a timeout, a
  navigation, or an app that never declared the capability it reports the context unavailable rather than anything
  stale. A tool rather than an injection,
  because app state changes on every click and injecting it would invalidate the cacheable prompt prefix on every
  send. It's a cache with no pull: the protocol has no way for the host to _ask_ for context, so an app that
  stops publishing goes stale silently. That is the contract — publish on every meaningful change.
- `app_<name>` calls the app's own tools. Arguments come from the model; results come back as text.

### What the model can and cannot cause

The model can read app state and call app tools. It cannot navigate the app, read the DOM, see the user's
selection unless the user promotes it, or reach anything the app didn't volunteer.

A write tool blocks on an approval prompt before it runs. Be precise about what that buys: the gate reads
`readOnlyHint`, which is the **app's own word about its own tool**, so it defends against a _confused model_ — one
that has read something persuasive in the app's content and decided to act on it — and not against a hostile app,
which could perform the same action directly without asking anyone. See [Security posture](#security-posture).

### Where the trust boundaries actually are

| Boundary                 | Enforced by                                                  | What it stops                                  |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------- |
| app → Thunderbolt        | origin + source check on every message; zod on every payload | Another frame impersonating the app            |
| app → model              | length caps, `<app-provided-tool-list>` fencing              | An app's text being read as instructions       |
| model → app              | host-side approval on write tools                            | A prompt-injected model writing through a tool |
| app → Thunderbolt's data | the browser's same-origin policy                             | Reading Thunderbolt's storage, cookies, DOM    |

The last one is the only boundary the _browser_ enforces rather than us, and it is by far the strongest. Everything
above it is our code, and worth reading with that in mind.

### A turn, end to end

1. User opens the app. The frame loads; the guest posts `ui/initialize`; the host replies with its capabilities and,
   if asked, a scoped identity token.
2. The host asks `tools/list` if the app declared the capability, and registers what comes back as `app_*` tools.
   An app that registers through `document.modelContext` in an effect declares nothing here and sends
   `ui/notifications/tools-changed` instead, which asks the same question a moment later.
3. The user asks a question. `src/ai/fetch.ts` builds the toolset and adds a prompt section naming the app.
4. The model calls `get_app_context`; the host asks the frame `ui/get-context` and answers with what it says now.
5. The model calls `app_set_order_status`. It's a write, so the host shows the approval prompt above the composer
   and blocks. On approve, the call goes over the bridge; the app performs it and returns text.
6. The app's state changed, and it publishes nothing — there is nothing to publish. The next
   `get_app_context` sees it.

### Which document is in the frame

The host has to know whether the handshake it is holding belongs to the document
currently in the frame or to the one before it. Getting this wrong leaves Select and Chat
lit over a dead page, the handshake deadline never re-armed, and every tool call the model
makes burning its full timeout against something that will never answer.

Ordering cannot answer it. A guest posts `initialize` from `connect()`, and when that runs
is the app's business:

| Guest        | Sequence                       | The handshake belongs to |
| ------------ | ------------------------------ | ------------------------ |
| plain script | `initialize` → `load`          | the new document         |
| React        | `load` → `initialize` → `load` | the **old** document     |

Both end in "a handshake, then a load", so the one-bit flag this replaced read the same in
each and kept `ready` over a page that had said nothing (THU-908). No ordering rule
separates them: the difference is _which document sent the message_, and a cross-origin
`load` event carries no identity to compare against.

So the guest mints an opaque `documentId` per document — module state, which is
per-document by construction — and the host asks `ui/identify` after every load. That
question is delivered to whatever is in the frame _now_, which makes the answer
unambiguous:

| The frame                   | Means                                        | Host does                  |
| --------------------------- | -------------------------------------------- | -------------------------- |
| replies with the id we hold | the bridge we've been talking to is still it | nothing                    |
| replies with a different id | a document we haven't handshaked             | reset, await its handshake |
| replies with `null`         | a bridge, but an SDK too old to have an id   | reset, await its handshake |
| says nothing in 500ms       | no bridge running yet, or none at all        | reset, await its handshake |

The asymmetry is deliberate: a spurious reset costs a re-handshake the guest performs
anyway, while a spurious _keep_ is the bug above. A guest whose SDK predates `documentId`
cannot be asked at all, and keeps the old best-effort guess — wrong for a React app that
navigates, right for everything else, and better than resetting a live document on every
load, which is what asking a guest that will never answer would do.

The id earns its keep a second way: a repeat `initialize` from the same document is now
recognisable and answered without tearing anything down. React's StrictMode
double-invokes the effect that calls `connect()`, so this is routine rather than exotic,
and it used to throw away the capabilities and the tool list and rediscover both for a
page that had not changed.

## Identity

An embedded app integrates with **one** issuer — us — rather than with every customer's IdP. However the user
signed in, the app gets the same short-lived JWT and validates it the same way. Without this, "onboard a customer
app with a config entry" quietly becomes "integrate that customer's identity provider".

- The audience is **operator-declared**, from `MINI_APPS`, never from the caller.
- Secrets are **per app**: one shared symmetric key would let any Mini App forge a token for any other.
- We never pass the user's Thunderbolt session, whose audience is us. That would be audience confusion.

Guests opt in with an `auth` capability, so an app that never asked doesn't cause a credential to exist.
`getAuthToken()` refreshes ahead of expiry, because a frame can sit open for hours.

**Not yet done:** asymmetric keys and a JWKS endpoint, which is the upgrade once apps are built by third parties
and secret distribution stops being a deploy-time detail. And what a Thunderbolt-issued token _can't_ do — let the
app call the customer's own backend as the real enterprise user — needs OAuth 2.0 Token Exchange (RFC 8693). See
THU-839; it's testable against the Keycloak already in `deploy/docker-compose.yml`.

Cookie-based silent SSO inside the frame is a dead end, and worth stating so nobody re-derives it: third-party
cookie blocking kills it on Safari today, and our own COEP posture — required because PowerSync's wa-sqlite worker
needs `SharedArrayBuffer` — removes the credentials it depends on.

## The embedding headers

Every Mini App must send all three, and **they fail identically: a blank panel with nothing in the embedding page's
console.** Rule them out before debugging anything else.

```
Content-Security-Policy: frame-ancestors 'self' <thunderbolt origin>
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Resource-Policy: cross-origin
```

## Security posture

For a customer deployment the honest framing is: **network isolation is the perimeter, app-level auth is the
enforcement.** The app is an internal web app on their infrastructure, not reachable from the public internet, and
gated by identity.

What the iframe relationship does _not_ give you is "only reachable via Thunderbolt". The browser loads the frame,
so anything it can reach in an iframe it can reach in a tab. `frame-ancestors` controls who may _embed_, not who
may _visit_.

What genuinely holds: Thunderbolt's server never talks to the app's server — the bridge is `postMessage` between
two origins in the user's browser. Same-origin policy keeps a compromised app out of Thunderbolt's storage,
cookies and DOM. Both sides pin origins on every message, with no wildcard `postMessage`. And write-tool approval
is enforced host-side rather than in the app, and the app never learns the outcome except by the tool's result.

Be precise about what that buys, though. The decision reads `readOnlyHint`, which is the app's own word about its own
tool — so **an app that declares a destructive tool read-only will skip the prompt.** The gate defends against a
confused model, not a hostile app: it stops a prompt-injected model writing through a tool the app marked as a write,
and it fails safe when the annotation is absent (absent means ask). It is not a boundary against the app, which can
perform the same action directly without asking anyone. Making it one would mean the operator classifying each tool in
`MINI_APPS` instead of trusting the descriptor — worth doing the day apps stop being first-party.

### Descriptor limits

A tool's `description` reaches the _system_ prompt once per tool for the life of the turn's cached prefix, so it is
capped at 300 characters (`maxToolDescriptionChars`), and an app may advertise at most 64 tools.

The cap is enforced by truncation, not rejection, and one bad descriptor never costs an app its other tools —
`parseToolsList` validates each entry on its own. That is a correction, not a design: parsing the array strictly
meant a single over-long description discarded the _entire_ toolset, silently, and a sample app shipped for a while
with a 386-character description and no working tools at all. If a descriptor is dropped for any other reason
the host logs it, because a tool going missing is otherwise indistinguishable from the model choosing not to call it.

### Limits, generally: nothing an app sends is rejected for being long

Every length bound in the protocol is a _host_ budget — prompt tokens, a one-line strip, memory — and an app has no
way to know them. So they all behave the way the descriptor cap does: **strings are clamped, collections are parsed
one element at a time, and over-count is sliced.** An app author never has to count characters, and an app that
exceeds a bound loses the overflow rather than the message.

That is a correction too, and it was the same bug five more times. A `.max()` on a field rejects the whole _message_,
not the field, and each instance surfaced as the feature simply not working: a select-all dropped the selection
notification so "Ask about this" never appeared; a summary built from the app's own data dropped the context update so
`get_app_context` kept describing the previous screen; a long display name dropped `initialize` so the app never
connected at all; a large tool result was reported to the model as "may have timed out" after the tool had already
run; and a wide table row failed the whole selection answer, returning nothing from exactly the content-dense views
the gesture exists for. None of them logged anything, because as far as the parser was concerned nothing arrived.

The single exception is `context.data` / `context.selection`, which are arbitrary structure rather than text: cutting
JSON at a character count produces invalid JSON, so an over-sized payload is withheld and the model is _told_ it was
withheld (`maxContextPayloadChars`). Use `.max()` only where the bound is a real correctness constraint the sender is
required to honour; otherwise use `clampedString` (`shared/lib/clamped-string.ts`), which both embedded surfaces share.

## Layout

```
shared/mini-app-protocol.ts             wire format, schemas, method names (v2)
shared/lib/clamped-string.ts            the clamp both surfaces bound their strings with

src/mini-apps/registry.ts               types + icon allowlist, and what an app is refused for
src/mini-apps/use-mini-apps.ts          fetches GET /mini-apps once per session
src/mini-apps/use-mini-app-bridge.ts    host side of the bridge
src/mini-apps/mini-app-auth.ts          token fetch
src/mini-apps/mini-app-tools.ts         app tools as model tools, plus their prompt section
src/mini-apps/mini-app-approval.ts      the write-approval gate and its deadline
src/mini-apps/approval-outcome.ts       how an approval ended, which the model is told
src/mini-apps/mini-app-store.ts         which app is open, for callers outside React
src/mini-apps/mini-app-context-tool.ts  get_app_context for an app
src/mini-apps/mini-app-prompt.ts        the app's section of the system prompt
src/mini-apps/use-mini-app-chat-panel-state.ts  which conversation the panel shows
src/mini-apps/use-chat-destination.ts   where selecting an app-linked chat lands

src/components/embedded/                gestures shared with artifacts — picking, popover, status
src/dal/mini-app-chats.ts               chats started from one app

backend/src/api/mini-apps.ts            GET /mini-apps, POST /mini-apps/:appId/token
backend/src/config/settings.ts          MINI_APPS parsing
```

Chat provenance is part of this feature too, and lives outside `src/mini-apps/`: `chat_threads.mini_app_id`
(migration 0029) records which app a chat came from, `MiniAppChatBadge` shows it on a sidebar row,
`MiniAppChatBanner` says so at the top of the chat, and `useChatDestination` is what reopens such a chat inside its
app rather than at `/chats/:id`.

A starter template for a new app — the embedding headers above, the guest half of the bridge, and a worked
`ui/get-context` — is answered, and is the canonical guest implementation:

```
git clone git@github.com:thunderbird/thunderbolt-miniapp-template.git
```

It is also what `MINI_APPS` defaults to in development, so a fresh checkout with the template running on :5190 has
a working app with no configuration. Treat the template's `lib/` as the reference for the guest side: the hit-test,
the handshake and the token refresh all live there, and this repo holds no copy of them.
