# The Universal Proxy

Every cross-origin request the app makes to a third-party endpoint the user configured — a BYOK LLM
completion, an MCP session, an ACP agent socket — goes through one endpoint pair on the backend:
`ALL /v1/proxy` ([backend/src/proxy/routes.ts](../../backend/src/proxy/routes.ts)) and
`WS /v1/proxy/ws` ([backend/src/proxy/ws.ts](../../backend/src/proxy/ws.ts)). The upstream is named
in a header rather than a path, and there is no MCP-specific route: `e2e/proxy-mcp.spec.ts` asserts
that the URL the browser hits ends in `/v1/proxy`.

It exists because a browser cannot call a provider API that sends no `Access-Control-Allow-Origin`
from the app origin — the request never leaves. The proxy is the minimum piece of server that makes
a bring-your-own-key app possible in a browser. It maps headers and forwards bytes; the caller's own
credential travels through it untouched and is never stored.

Two consequences shape everything below. First, the proxy is a general-purpose egress for a
user-supplied URL, so it is an SSRF surface and is treated as one. Second, its responses come back
from _our_ origin, so anything the upstream says about cookies, content type, or framing has to be
neutralised before the browser sees it.

## The wire contract

Both ends import their header names from [shared/proxy-protocol.ts](../../shared/proxy-protocol.ts).
Drift between the client and the route is silent breakage, which is why the strings live in one
module rather than being typed twice.

| Header                       | Direction | Meaning                                                                              |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `X-Proxy-Target-Url`         | request   | The upstream URL. Required; `http://` is auto-upgraded to `https://`                 |
| `X-Proxy-Follow-Redirects`   | request   | `true`/`false`, case-insensitive; anything else falls back to the per-method default |
| `X-Proxy-Passthrough-<name>` | request   | A header to present to the upstream, with the prefix stripped                        |
| `X-Proxy-Passthrough-<name>` | response  | An upstream response header, re-prefixed so the browser does not act on it           |
| `X-Proxy-Final-Url`          | response  | The URL of the last hop, after any redirect following                                |

The target is a header rather than a path segment on purpose: standard HTTP access logs record method
and path, so a URL in the path would write every page a user looked at into the log
([backend/src/proxy/routes.ts:208-210](../../backend/src/proxy/routes.ts#L208)). The observability
layer keeps the same promise — it records `target_host` and never the full URL
([backend/src/proxy/observability.ts:79-85](../../backend/src/proxy/observability.ts#L79)).

**Two credentials are in play on one request and confusing them is the classic mistake.** The plain
`Authorization` header on the outer hop authenticates _you_ to `/v1/proxy` (Thunderbolt session
bearer). The upstream's credential rides as `X-Proxy-Passthrough-Authorization` — or
`X-Proxy-Passthrough-X-Api-Key`, or whatever the provider wants. `createProxyFetch` performs that
promotion for you, so call sites set a normal `Authorization` header and never touch the prefix (see
[mcp-connections.md](./mcp-connections.md) for the MCP instance of this).

Passthrough values must be printable ASCII (`0x20`–`0x7E`) or the request is rejected with 400. The
body is forwarded verbatim: the route is registered with `parse: 'none'`
([routes.ts:446](../../backend/src/proxy/routes.ts#L446)) so Elysia never parses or re-serialises it.
Allowed methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`; anything else is 405.

On the response side every upstream header is re-prefixed, except the hop-by-hop set and the
`Set-Cookie` family listed in `droppedResponseHeaders` — the response's origin is Thunderbolt, not
the upstream, so forwarding a cookie would install it against the wrong site. `content-encoding` is
deliberately _not_ dropped; see the Bun coupling below.

### The CORS exposure trap

`unwrapHostedResponse` ([src/lib/proxy-fetch.ts:119-140](../../src/lib/proxy-fetch.ts#L119)) rebuilds
a natural-looking `Response` by walking `response.headers` — and cross-origin, a browser only puts
headers in there that the server listed in `Access-Control-Expose-Headers`. So an upstream response
header the client needs to _read_ must be added to `corsExposeHeaders`
([backend/src/config/settings.ts:11](../../backend/src/config/settings.ts#L11)) as
`X-Proxy-Passthrough-<Name>`. That is why the default list carries entries like
`X-Proxy-Passthrough-Mcp-Session-Id` and `X-Proxy-Passthrough-Anthropic-Version`. Request headers
need no such registration — the CORS config uses `allowedHeaders: true` and echoes whatever the
browser asks for, precisely because the passthrough namespace is open-ended. The reasoning is in
[AGENTS.md](../../AGENTS.md) under "CORS and API headers".

### Forced response headers

Four headers are set unprefixed on every proxy response and override anything the upstream sent
([routes.ts:119-123](../../backend/src/proxy/routes.ts#L119)):

```text
Content-Security-Policy: sandbox
X-Content-Type-Options: nosniff
Content-Disposition: attachment
Cross-Origin-Resource-Policy: cross-origin
```

A proxy response is an opaque payload that happens to be served from our origin. Without these, an
upstream returning HTML could be navigated to and would execute as a same-origin document. The
client strips the two framing headers named in `proxyFramingHeaders` when it rebuilds the response,
so caller code never sees them.

## SSRF and the redirect loop

`validateAndPin` ([backend/src/utils/url-validation.ts:77-118](../../backend/src/utils/url-validation.ts#L77))
resolves the hostname, rejects the request if _any_ resolved address is private, internal or reserved,
then connects to the resolved IP with the original `Host` header. Pinning to the address that was
validated is what closes the DNS-rebinding window between check and connect. A target that is
already an IP literal skips the lookup but is classified the same way. Userinfo is stripped both by
the route and by `validateAndPin`; non-`http(s)` schemes never get that far, because the route
normalises the target through `ensureHttps` first and rejects anything that is not `http`/`https`.

The route runs its own per-hop loop rather than letting `fetch` follow redirects, because a redirect
is a fresh SSRF decision: hop 0 is the initial fetch and hops 1–5 are follows, each re-validated and
re-pinned ([routes.ts:301-321](../../backend/src/proxy/routes.ts#L301)). Alongside that:

- **`Authorization` is dropped once a redirect leaves the initial origin**
  ([routes.ts:421-423](../../backend/src/proxy/routes.ts#L421)), so a redirect cannot be used to
  harvest the caller's upstream key.
- **Following is opt-in for methods with a body.** `GET`/`HEAD`/`OPTIONS` follow by default; other
  methods return the 3xx as-is unless `X-Proxy-Follow-Redirects: true`, which forces the body to be
  buffered so it can be replayed on 307/308. A body-carrying request that is _not_ following
  redirects streams straight through to the upstream instead.
- **Method rewriting follows RFC 7231**: 303 always becomes `GET`; 301/302 become `GET` for anything
  that was not `GET`/`HEAD`.
- A failed validation is 400 on hop 0 (the caller asked for something blocked) and 502 on a later hop
  (the _upstream_ pointed somewhere blocked). Exhausting the hop budget is 502.

The WebSocket relay validates by hostname only — `wss://` scheme, plus the same private-address
classification — and does **not** DNS-pin
([ws.ts:107-127](../../backend/src/proxy/ws.ts#L107)). The rebinding gap there is known and marked in
the source.

One practical consequence of blocking loopback: a local model server (Ollama, LM Studio) can never be
reached through the proxy, because `localhost` on the backend is not the user's machine. Loopback
custom endpoints therefore bypass the proxy and use the plain fetch instead
([src/ai/fetch.ts:295-312](../../src/ai/fetch.ts#L295)); everything else — including RFC-1918 LAN
addresses and `host.docker.internal` — stays on the proxy path.

## Caps, timeouts, and how they fail

| Limit                | Value            | Where                                                                           |
| -------------------- | ---------------- | ------------------------------------------------------------------------------- |
| Request body         | 10 MB            | [routes.ts:27](../../backend/src/proxy/routes.ts#L27) — 413                     |
| Response body        | 10 MB            | [routes.ts:30](../../backend/src/proxy/routes.ts#L30) — stream terminates       |
| Stream idle          | 30 s             | [routes.ts:31](../../backend/src/proxy/routes.ts#L31) — stream terminates       |
| Redirect hops        | 5                | [routes.ts:28](../../backend/src/proxy/routes.ts#L28) — 502                     |
| DNS lookup           | 5 s              | [routes.ts:29](../../backend/src/proxy/routes.ts#L29) — 400 on hop 0, 502 later |
| WS pre-connect queue | 64 msgs / 256 KB | [ws.ts:14-15](../../backend/src/proxy/ws.ts#L14) — close 4008                   |

The body caps and the idle watchdog are enforced by `capStream`
([backend/src/proxy/streaming.ts](../../backend/src/proxy/streaming.ts)), which wraps both the upload
and the download. Three properties matter to a caller:

- **The idle timeout is per-chunk, not per-request.** A streaming completion that goes 30 seconds
  without emitting a token is terminated. Long tool calls on the upstream side are the realistic way
  to hit this.
- **Termination, not error.** Response headers have already been sent by the time a cap fires, so the
  stream is cut rather than failed — the caller sees the upstream's status and a truncated body. The
  categorical reason lands in observability as `cap_exceeded` or `idle_timeout`.
- **Bytes are counted post-compression** — what the wire carried. A gzip-bombed resource trips the cap
  on the compressed stream, and the client, which performs the decode, bears the inflation risk for
  its own traffic ([routes.ts:22-27](../../backend/src/proxy/routes.ts#L22)).

Oversized uploads are caught on three paths: a `Content-Length` over the cap is rejected with 413
before any upstream connection is opened; a body being buffered for redirect replay is read through
a bounded accumulator that returns 413 the moment it goes over (rather than materialising the whole
upload first, which a chunked request could use to exhaust memory); and a body streaming straight
through is wrapped in `capStream`, whose `onAbort` aborts the upstream request.

### The Bun `decompress: false` coupling

The upstream fetch passes two non-standard options,
[routes.ts:353-372](../../backend/src/proxy/routes.ts#L353):

```ts
decompress: false,
duplex: 'half',
```

Bun ≥ 1.3 auto-decompresses a response body but keeps `content-encoding` on the `Response`. Since the
proxy forwards that header, decompressing would hand the browser a `gzip`-labelled body of plain
bytes and the decode would corrupt it. `decompress: false` keeps the original bytes and the header
truthful, so the browser performs the decode itself.

**This is a documented silent-breakage risk on a Bun upgrade.** The unit test asserts that the option
is _passed_, not that Bun honours it, so a behaviour change in Bun will keep the suite green while
real responses break. The behaviour was verified empirically on Bun 1.3.10; add an integration test
before bumping the Bun major.

## The WebSocket relay

`/v1/proxy/ws` is a fixed endpoint — as with HTTP, the upstream URL is not in the path. Everything
the handshake needs travels in `Sec-WebSocket-Protocol`, because a browser can set neither an
`Authorization` header nor a cross-site cookie on `new WebSocket()`, and the two remaining
handshake-time channels are the URL (logged by every default access-log format, and by `Referer`) and
the subprotocol list (logged by none). The client offers, in order
([src/lib/proxy-fetch.ts:254-279](../../src/lib/proxy-fetch.ts#L254)):

```text
thunderbolt.v1                      # carrier
thunderbolt.bearer.<base64url>      # session bearer, base64url-encoded
tbproxy.target.<base64url(url)>     # upstream URL
…caller protocols                   # forwarded to the upstream handshake
```

The bearer is base64url-encoded because a raw Better Auth token (`<sessionToken>.<base64Signature>`)
contains `.`, `+`, `/` and `=`, none of which are legal in an RFC 6455 subprotocol token
([shared/ws-bearer.ts](../../shared/ws-bearer.ts)). The carrier entry exists because RFC 6455
requires the server to echo one offered subprotocol for strict clients to accept the upgrade — and
echoing the _bearer_ would put the credential on `WebSocket.protocol` where page JS and response logs
can read it. So the carrier is echoed and the bearer never is
([ws.ts:237-259](../../backend/src/proxy/ws.ts#L237)).

Two placement decisions in the handler are load-bearing:

- **The bearer is validated in `open()`, not `beforeHandle`** — Elysia/Bun can invoke `beforeHandle`
  more than once per upgrade, so it holds only the synchronous, idempotent target checks. `open()`
  runs exactly once per accepted socket, validates the bearer through the same Better Auth path REST
  uses, and additionally refuses anonymous users
  ([ws.ts:276-293](../../backend/src/proxy/ws.ts#L276), [backend/src/auth/ws-bearer-auth.ts](../../backend/src/auth/ws-bearer-auth.ts)).
- **The whole `tbproxy.*` and `thunderbolt.*` namespace is stripped before the upstream handshake**
  ([ws.ts:86](../../backend/src/proxy/ws.ts#L86)). These are our own control and auth plumbing; caller
  protocols pass through so the upstream still negotiates normally.

Messages arriving before the upstream socket opens are queued and flushed on `open`. Close codes:

| Code   | Meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| `4001` | Upgrade accepted, then refused — bearer missing, invalid, or anonymous |
| `4002` | Target subprotocol unparseable at `open()` time                        |
| `4003` | Reserved for a non-`wss://` target; classified but not emitted today   |
| `4008` | Pre-connect queue exceeded its message or byte budget                  |
| `1011` | Upstream connection failed or errored                                  |

Otherwise the upstream's own close code and reason are relayed downstream verbatim.

An unparseable subprotocol or an invalid target is caught earlier, in `beforeHandle`, and answered
with an HTTP 400 that refuses the upgrade — so a client sees a failed handshake (`1002`/`1006`) rather
than a close code. `4001`, in the app-defined 4000–4999 range, exists precisely to distinguish "the
server accepted my socket and then refused me" (re-login) from "I never reached the server" (network
error).

`/v1/proxy/ws` is one of the paths exempt from the minimum-app-version gate, because a browser cannot
attach `X-App-Version` to a handshake. `/v1/proxy` is gated like any other route — so the client adds
the header to the outer hop itself.

## Auth, rate limiting, observability

The HTTP route sits inside `guard({ auth: true }, …)` — any session will do — and consumes the `pro`
rate-limit tier, 100 requests/minute keyed on `user:<id>`. The WS route mounts the same limiter, but
the limiter keys on the `user` the auth macro resolves and the WS bearer is authorized inside
`open()` instead, so the handshake is _not_ user-limited. The full inventory — auth mode, tier, and
version-gate status for every backend route — is in
[backend-api-surface.md](./backend-api-surface.md).

Each request emits one structured `proxy_request` (or `proxy_ws_relay`) event through Pino and sets
matching `proxy.*` attributes on the active OpenTelemetry span. Failures are tagged with a
categorical `error_type` — `ssrf`, `dns_timeout`, `idle_timeout`, `cap_exceeded`, `upstream_4xx`,
`upstream_5xx`, `invalid_target` (plus `auth_reject`, declared in the enum but not emitted by either
proxy path today) — so a client mistake, an upstream outage and an exfiltration attempt are
distinguishable on a dashboard. Emission happens once, from the response
stream's completion callback, so byte counts and timings never disagree with what the caller
received. Nothing goes to PostHog: the proxy is infrastructure, not a product event surface.

## The client side: which fetch to use

There are five fetch entry points in the frontend and they are not interchangeable.

| Use it for                                                                   | Entry point                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An authenticated call to our own backend                                     | `useHttpClient()` ([src/contexts/http-client-context.tsx](../../src/contexts/http-client-context.tsx)), or `createAuthenticatedClient` ([src/lib/http.ts:185](../../src/lib/http.ts#L185)) |
| An external API with no app headers or auth                                  | `http` ([src/lib/http.ts:252](../../src/lib/http.ts#L252))                                                                                                                                 |
| An LLM, MCP, or ACP upstream                                                 | `useFetch()` / `useProxyFetchGetter()` ([src/lib/proxy-fetch-context.tsx](../../src/lib/proxy-fetch-context.tsx))                                                                          |
| A CORS-blocked fetch that must not touch the proxy (loopback, model catalog) | `fetch` from [src/lib/fetch.ts](../../src/lib/fetch.ts)                                                                                                                                    |
| An MCP SDK transport that offers no fetch injection                          | `TauriStreamableHTTPClientTransport` ([src/lib/tauri-http-transport.ts:27](../../src/lib/tauri-http-transport.ts#L27))                                                                     |

`createAuthenticatedClient` is the only path that injects `X-Device-ID`, `X-Device-Name`,
`X-App-Version` and `X-App-Language`, and the only one that turns a 401 into a
`powersync_credentials_invalid` event and a 426 into the upgrade blocker. Those four headers and both
response hooks sit behind an origin-and-prefix guard (`isBackendRequest`), so the same client can
call an external API without leaking app identity headers to it or misreading its 401 as an expired
session. The bearer itself is attached regardless of origin — external callers pass their own
`Authorization`, and the hook leaves a caller-set header alone. `src/lib/fetch.ts` is the
Tauri-aware escape hatch: it honours the "Use Native Fetch" dev setting and re-checks the
`native_fetch` capability before invoking the plugin, so a stale `true` from an earlier build cannot
call an unregistered plugin.
`TauriStreamableHTTPClientTransport` monkey-patches `globalThis.fetch` for the duration of the SDK
constructor — a workaround for a transport that provides no injection point, and not a pattern to
copy.

### Hosted and Standalone

`createProxyFetch` hides one branch from every call site
([src/lib/proxy-fetch.ts:200-236](../../src/lib/proxy-fetch.ts#L200)):

- **Hosted** wraps the request for `${cloudUrl}/proxy`. Always the case on web.
- **Standalone** calls the upstream directly through Tauri's HTTP plugin, so the user's IP never
  reaches our backend. It requires all three of: running under Tauri, the `proxy_enabled` toggle
  _off_, and a build compiled with the `native_fetch` capability.

Note the polarity — `proxy_enabled` off is the direct path, and off is the default
(`useLocalStorage('proxy_enabled', 'false')`). Web always proxies because browser CORS leaves no
choice, so the setting is UI-disabled there and when signed out
([src/settings/preferences.tsx:207-216](../../src/settings/preferences.tsx#L207)). A Tauri build
without `--features native_fetch` falls back to the hosted proxy regardless of the toggle, because
the plugin's JS shim would throw "plugin http not found". The effective value is computed in one
place, `computeEffectiveProxyEnabled`, which every caller — the React provider, the MCP transports,
the settings toggle, and the ACP transport's `isStandaloneTransport` — calls rather than re-deriving.

### Outer-hop headers must not be promoted

`skipHeaders` ([src/lib/proxy-fetch.ts:64-85](../../src/lib/proxy-fetch.ts#L64)) lists the headers
that are never turned into `X-Proxy-Passthrough-*` entries. Most are browser-injected noise (`origin`,
`referer`, the `sec-*` family) whose forwarding would leak browser context upstream. Two are there for
a different reason: `x-app-version` and `x-app-language` belong to the hop between the app and _our_
backend, and promoting them would ship them to an external LLM or MCP provider. The proxy fetch sets
`X-App-Version` on the outer request itself, after the promotion step, for exactly this reason. The
`X-App-Language` contract is described in [AGENTS.md](../../AGENTS.md) under "The `X-App-Language`
header".

### A 426 must be matched on the body, not the status

The proxy relays upstream status codes verbatim, so a third-party provider answering `426 Upgrade
Required` arrives at the client indistinguishable, by status alone, from our own version gate. Acting
on the status would blank the whole app on someone else's response. Our gate is the only party that
pairs 426 with an `APP_VERSION_UNSUPPORTED` body code, so that code is the discriminator
([src/lib/proxy-fetch.ts:152-163](../../src/lib/proxy-fetch.ts#L152)). The check reads a clone, so the
body still reaches the caller intact. On the direct-to-backend path in `src/lib/http.ts` the status
_is_ sufficient, because there is no upstream to confuse it with.

### `useFetch()` versus `useProxyFetchGetter()`

The provider memoises one `proxyFetch` per `cloudUrl` and effective-proxy value. `useFetch()` returns
that memoised value, which is correct in a component that re-renders when either changes.

It is wrong in a closure that outlives a render. The AI SDK's `customFetch` and the chat instance are
built once when a chat is created; a `useFetch()` captured there freezes the proxy as it looked at
that moment, so changing `cloud_url` or the proxy toggle would not reach an open chat.
`useProxyFetchGetter()` returns a stable getter backed by a ref — call it at invocation time
([src/lib/proxy-fetch-context.tsx:111](../../src/lib/proxy-fetch-context.tsx#L111)). The AI model
factory takes `getProxyFetch: () => FetchFn` rather than a `FetchFn` for this reason.

## Where the code lives

| Piece                       | File                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- |
| HTTP route, redirect loop   | [backend/src/proxy/routes.ts](../../backend/src/proxy/routes.ts)                 |
| WebSocket relay             | [backend/src/proxy/ws.ts](../../backend/src/proxy/ws.ts)                         |
| Byte cap and idle watchdog  | [backend/src/proxy/streaming.ts](../../backend/src/proxy/streaming.ts)           |
| Logging and OTel attributes | [backend/src/proxy/observability.ts](../../backend/src/proxy/observability.ts)   |
| DNS pinning, SSRF checks    | [backend/src/utils/url-validation.ts](../../backend/src/utils/url-validation.ts) |
| Header names, dropped sets  | [shared/proxy-protocol.ts](../../shared/proxy-protocol.ts)                       |
| WS bearer codec, carrier    | [shared/ws-bearer.ts](../../shared/ws-bearer.ts)                                 |
| WS bearer validation        | [backend/src/auth/ws-bearer-auth.ts](../../backend/src/auth/ws-bearer-auth.ts)   |
| Client fetch and WS factory | [src/lib/proxy-fetch.ts](../../src/lib/proxy-fetch.ts)                           |
| React provider and hooks    | [src/lib/proxy-fetch-context.tsx](../../src/lib/proxy-fetch-context.tsx)         |
| Mount and rate-limit wiring | [backend/src/index.ts:128-162](../../backend/src/index.ts#L128)                  |

Coverage: `backend/src/proxy/routes.test.ts` and `e2e.test.ts` for the HTTP contract, `ws.test.ts`
and `ws-e2e.test.ts` for the relay, `streaming.test.ts` for the caps, `observability.test.ts` and
`observability.e2e.test.ts` for the event shape. `ws-e2e.test.ts` runs in its own CI step — once,
with retries, rather than under the 5× rerun the rest of the backend suite gets, because
same-process Bun WS event delivery is flaky under load
([.github/workflows/ci.yml](../../.github/workflows/ci.yml)). The Playwright specs
`e2e/proxy-fetch.spec.ts`, `e2e/proxy-passthrough-headers.spec.ts`, `e2e/proxy-mcp.spec.ts` and
`e2e/proxy-websocket.spec.ts` pin the browser-side wire format. They assert on what the client sent
against a stubbed transport — `page.route()` for the three HTTP specs, a `globalThis.WebSocket` stub
for the relay spec — because the backend's SSRF guard blocks loopback upstreams, so no real upstream
can be stood up in dev.
