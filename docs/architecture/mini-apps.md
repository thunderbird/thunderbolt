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

### Why not WebMCP

WebMCP has no UI transport at all, and never will: it assumes the page is already on screen and only lets it
declare tools. It can replace `tools/list` + `tools/call` and nothing else — not context publishing, selection,
theme, or chat-open.

Its natural home in Thunderbolt is actually the **native webview** (`src/content-view/sidebar-webview.tsx`), which
loads arbitrary third-party sites that refuse to be iframed — the same shape as ChatGPT desktop's built-in
browser, which shipped WebMCP support in August 2026. That's also where the constraint bites: Tauri is WKWebView
on macOS and WebKitGTK on Linux, and neither implements `document.modelContext`. Only Windows (WebView2) could.

So the template dual-registers tools with WebMCP where the runtime has it, and never depends on it.

## Surfaces: one embed path

**Decision: the iframe path covers every surface.** The native webview is a different feature, for a different
problem.

Mini Apps are _cooperative_ — they send `frame-ancestors` naming us — so a plain `<iframe src>` works everywhere,
and gives us `postMessage` for free. The native webview exists for arbitrary sites that send `X-Frame-Options`,
which no Mini App does.

| Surface               | Embed  | Open                                                                                |
| --------------------- | ------ | ----------------------------------------------------------------------------------- |
| Web (desktop browser) | iframe | —                                                                                   |
| Tauri desktop         | iframe | `frame-src` is compiled into `tauri.conf.json`, so a new app origin needs a rebuild |
| Tauri iOS / Android   | —      | not offered — the viewport gate below catches these                                 |
| Mobile web            | —      | not offered — same gate                                                             |

**Mini Apps are web and desktop only** (THU-830). The gate is on _viewport_, not platform: the split view,
highlight-to-ask and the marquee all need pointer input and room, and a 700px browser window is as unworkable as a
phone. `useIsMobile` exempts the Tauri desktop app at any width, so narrowing the desktop window keeps the feature
while narrowing a browser does not.

Below the breakpoint the sidebar entry is hidden and the route renders a size notice rather than disappearing — a
deep link out of a synced chat, or someone narrowing their window mid-session, is told what happened instead of
hitting Not Found. An earlier cut overlaid the chat on the app for phones; that layout is gone, so nothing here
depends on iOS Safari's COEP support being confirmed.

**The Tauri `frame-src` problem is real and unsolved.** Everything else in the registry moved to runtime config
(`MINI_APPS`), but Tauri compiles its CSP in at startup — a reload won't pick up a change, and a new customer
origin means a new desktop build. Options are a build-time config patch (`tauri build --config`) or dropping the
frame CSP and relying on origin checks alone, which is worse. Until this is solved, desktop is per-customer-build
even though web is not.

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

## The two headers

Every Mini App must send both, and **they fail identically: a blank panel with nothing in the embedding page's
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
meant a single over-long description discarded the _entire_ toolset, silently, and the finance sample shipped for a
while with a 386-character description and no working tools at all. If a descriptor is dropped for any other reason
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
run; and a wide table row failed the whole marquee answer, returning zero chips from exactly the content-dense views
the gesture exists for. None of them logged anything, because as far as the parser was concerned nothing arrived.

The single exception is `context.data` / `context.selection`, which are arbitrary structure rather than text: cutting
JSON at a character count produces invalid JSON, so an over-sized payload is withheld and the model is _told_ it was
withheld (`maxContextPayloadChars`). Use `.max()` only where the bound is a real correctness constraint the sender is
required to honour; otherwise use `clampedString` (`shared/lib/clamped-string.ts`), which both embedded surfaces share.

## Layout

```
shared/mini-app-protocol.ts     wire format, schemas, method names (v2)
src/mini-apps/registry.ts       types + icon allowlist; the data comes from the backend
src/mini-apps/use-mini-apps.ts  fetches GET /mini-apps once per session
src/mini-apps/use-mini-app-bridge.ts  host side of the bridge
src/mini-apps/mini-app-auth.ts  token fetch
backend/src/api/mini-apps.ts    GET /mini-apps, POST /mini-apps/:appId/token
backend/src/config/settings.ts  MINI_APPS parsing
```

A starter template for a new app — the two headers above, the guest half of the bridge, and a worked
`ui/update-model-context` — is tracked as THU-834. It has no home yet; until it is published, copy the guest
bridge out of one of the sample apps. (This line used to point at a path in one engineer's home directory,
which resolved for exactly one person.)
