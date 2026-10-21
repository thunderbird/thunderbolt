# The Universal Proxy

One endpoint pair carries relayed requests to user-configured third parties: own-key model
inference and catalogs, MCP sessions, and ACP agent sockets. Web uses the relay; Tauri HTTP and
remote ACP WebSockets opt in with Use Cloud Proxy, except loopback ACP targets stay direct on Tauri.

| Endpoint          | Implementation                                                      |
| ----------------- | ------------------------------------------------------------------- |
| `ALL /v1/proxy`   | [backend/src/proxy/routes.ts](../../../backend/src/proxy/routes.ts) |
| `WS /v1/proxy/ws` | [backend/src/proxy/ws.ts](../../../backend/src/proxy/ws.ts)         |

The upstream is named in a header, and there is no MCP-specific route: `e2e/proxy-mcp.spec.ts`
asserts the browser's URL ends in `/v1/proxy`. The proxy exists because a browser cannot call a
provider API that sends no `Access-Control-Allow-Origin`; it maps headers and forwards bytes, and
the caller's credential passes through untouched and is never stored. So it is general-purpose
egress for a user-supplied URL (an SSRF surface) serving responses from _our_ origin (upstream
cookies, content type and framing must be neutralised).

## The wire contract

| Header                       | Direction | Meaning                                                                                                                                                   |
| ---------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Proxy-Target-Url`         | request   | The upstream URL. Required; `http://` is auto-upgraded to `https://`                                                                                      |
| `X-Proxy-Follow-Redirects`   | request   | `true`/`false`, case-insensitive; anything else falls back to the per-method default                                                                      |
| `X-Proxy-Passthrough-<name>` | request   | A header to present to the upstream, with the prefix stripped                                                                                             |
| `X-Proxy-Passthrough-<name>` | response  | An upstream response header, re-prefixed so the browser does not act on it                                                                                |
| `X-Proxy-Final-Url`          | response  | The URL of the last hop, after any redirect following. Its absence marks a response from the proxy itself, so only that kind of 401 can sign the user out |

Both ends import these names from [shared/proxy-protocol.ts](../../../shared/proxy-protocol.ts); drift
is silent breakage.

- Passthrough values must be printable ASCII (`0x20`-`0x7E`), else 400.
- Methods: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`; anything else is 405.
- The body is forwarded verbatim; `parse: 'none'`
  ([routes.ts:446](../../../backend/src/proxy/routes.ts#L446)) keeps Elysia from parsing or
  re-serialising it.
- Response headers are re-prefixed except the hop-by-hop set and the `Set-Cookie` family in
  `droppedResponseHeaders`; the response's origin is Thunderbolt, so a forwarded cookie installs
  against the wrong site. `content-encoding` is deliberately _not_ dropped, see
  [the Bun coupling](#the-bun-decompress-false-coupling).
- The target is a header because access logs record the path, which would log every page a user
  visited ([routes.ts:208-210](../../../backend/src/proxy/routes.ts#L208)); observability records
  `target_host` only ([observability.ts:79-85](../../../backend/src/proxy/observability.ts#L79)).

### Which credential goes where

| Credential                  | Header                                                                                               | Authenticates        |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| Thunderbolt session bearer  | `Authorization` (outer hop)                                                                          | You, to `/v1/proxy`  |
| The upstream provider's key | `X-Proxy-Passthrough-Authorization`, `X-Proxy-Passthrough-X-Api-Key`, or whatever the provider wants | You, to the upstream |

`createProxyFetch` promotes the upstream key, so call sites set a plain `Authorization` header
([mcp-connections.md](mcp-connections.md) covers the MCP instance).

### Reading an upstream response header

Add it to `corsExposeHeaders`
([backend/src/config/settings.ts:11](../../../backend/src/config/settings.ts#L11)) as
`X-Proxy-Passthrough-<Name>`, hence defaults like `X-Proxy-Passthrough-Mcp-Session-Id` and
`X-Proxy-Passthrough-Anthropic-Version`. `unwrapHostedResponse`
([src/lib/proxy-fetch.ts:119-140](../../../src/lib/proxy-fetch.ts#L119)) rebuilds the `Response` from
`response.headers`, which cross-origin holds only what `Access-Control-Expose-Headers` listed.
Request headers need none, since the open-ended namespace forces `allowedHeaders: true`
([AGENTS.md](../../../AGENTS.md), "CORS and API headers").

### Forced response headers

Set unprefixed on every response, overriding the upstream
([routes.ts:119-123](../../../backend/src/proxy/routes.ts#L119)):

```text
Content-Security-Policy: sandbox
X-Content-Type-Options: nosniff
Content-Disposition: attachment
Cross-Origin-Resource-Policy: cross-origin
```

Without them an upstream returning HTML could be navigated to and execute as a same-origin
document. The client strips the two `proxyFramingHeaders` when rebuilding.

## SSRF and the redirect loop

`validateAndPin` ([backend/src/utils/url-validation.ts:77-118](../../../backend/src/utils/url-validation.ts#L77))
resolves the hostname, rejects if _any_ resolved address is private, internal or reserved, then
connects to that IP with the original `Host` header. Pinning closes the DNS-rebinding window
between check and connect.

- An IP-literal target skips the lookup but is classified the same way.
- Userinfo is stripped by both the route and `validateAndPin`.
- `ensureHttps` normalises first and rejects any non-`http(s)` scheme.

**Redirects are followed hop by hop in the route**, not by `fetch`, because each redirect is a fresh
SSRF decision. Hop 0 is the initial fetch; hops 1-5 are follows, each re-validated and re-pinned
([routes.ts:301-321](../../../backend/src/proxy/routes.ts#L301)).

- **`Authorization` is dropped once a redirect leaves the initial origin**
  ([routes.ts:421-423](../../../backend/src/proxy/routes.ts#L421)), so a redirect cannot harvest the
  upstream key.
- **Following is opt-in for methods with a body.** `GET`/`HEAD`/`OPTIONS` follow by default; others
  return the 3xx as-is unless `X-Proxy-Follow-Redirects: true`, which buffers the body for replay
  on 307/308. A body-carrying request not following redirects streams straight through.
- **RFC 7231 method rewriting**: 303 always becomes `GET`; 301/302 become `GET` for anything that
  was not `GET`/`HEAD`.
- **Status depends on the hop**: failed validation is 400 on hop 0 (the caller asked for something
  blocked), 502 later (the _upstream_ did). A spent hop budget is 502.
- **The WS relay validates by hostname only** (`wss://` plus the same private-address
  classification) and does **not** DNS-pin; the rebinding gap is marked in the source
  ([ws.ts:107-127](../../../backend/src/proxy/ws.ts#L107)).
- **Local model servers bypass the proxy** (Ollama, LM Studio), since backend `localhost` is not
  the user's machine, so loopback endpoints use the plain fetch
  ([src/ai/fetch.ts:295-312](../../../src/ai/fetch.ts#L295)). Everything else follows the platform and
  Cloud Proxy setting; web and Tauri with the toggle on use the hosted proxy, which blocks RFC-1918 LAN addresses and `host.docker.internal`.

## Caps, timeouts, and how they fail

| Limit                | Value            | Where                                                                             |
| -------------------- | ---------------- | --------------------------------------------------------------------------------- |
| Request body         | 10 MB            | [routes.ts:27](../../../backend/src/proxy/routes.ts#L27), 413                     |
| Response body        | 10 MB            | [routes.ts:30](../../../backend/src/proxy/routes.ts#L30), stream terminates       |
| Stream idle          | 30 s             | [routes.ts:31](../../../backend/src/proxy/routes.ts#L31), stream terminates       |
| Redirect hops        | 5                | [routes.ts:28](../../../backend/src/proxy/routes.ts#L28), 502                     |
| DNS lookup           | 5 s              | [routes.ts:29](../../../backend/src/proxy/routes.ts#L29), 400 on hop 0, 502 later |
| WS pre-connect queue | 64 msgs / 256 KB | [ws.ts:14-15](../../../backend/src/proxy/ws.ts#L14), close 4008                   |

`capStream` ([backend/src/proxy/streaming.ts](../../../backend/src/proxy/streaming.ts)) enforces the
caps and the watchdog on upload and download.

- **Idle is per-chunk, not per-request.** A completion that goes 30 seconds without a token is
  terminated; long upstream tool calls are the realistic way to hit this.
- **Termination, not error.** Headers are already sent when a cap fires, so the caller sees the
  upstream's status with a truncated body; observability records `cap_exceeded`/`idle_timeout`.
- **Bytes are counted post-compression**, what the wire carried, so a gzip bomb trips the cap
  compressed and the client, which decodes, bears the inflation risk
  ([routes.ts:22-27](../../../backend/src/proxy/routes.ts#L22)).

Oversized uploads are caught three ways: `Content-Length` over the cap is 413 before any upstream
connection opens; a body buffered for redirect replay uses a bounded accumulator returning 413 the
moment it goes over (materialising the whole upload would let a chunked request exhaust memory); a
straight-through body is wrapped in `capStream`, whose `onAbort` aborts upstream.

### The Bun `decompress: false` coupling

On the upstream fetch ([routes.ts:353-372](../../../backend/src/proxy/routes.ts#L353)):

```ts
decompress: false,
duplex: 'half',
```

Bun >= 1.3 auto-decompresses a response body but keeps `content-encoding` on the `Response`. The
proxy forwards that header, so decompressing would hand the browser a `gzip`-labelled body of plain
bytes and corrupt the decode. `decompress: false` keeps the bytes and the header truthful.

**Silent-breakage risk on a Bun upgrade:** the unit test asserts the option is _passed_, not that
Bun honours it, so a Bun behaviour change keeps the suite green while responses break. Verified on
Bun 1.3.10; add an integration test before bumping the Bun major.

## The WebSocket relay

`/v1/proxy/ws` is fixed; as with HTTP the upstream URL is not in the path. Everything travels in
`Sec-WebSocket-Protocol`, offered in order
([src/lib/proxy-fetch.ts:254-279](../../../src/lib/proxy-fetch.ts#L254)):

```text
thunderbolt.v1                      # carrier
thunderbolt.bearer.<base64url>      # session bearer, base64url-encoded
tbproxy.target.<base64url(url)>     # upstream URL
…caller protocols                   # forwarded to the upstream handshake
```

A browser can set neither an `Authorization` header nor a cross-site cookie on `new WebSocket()`,
leaving the URL (logged by every default access-log format, and by `Referer`) and the subprotocol
list (logged by none). Hence:

- **The bearer is base64url-encoded** because a raw Better Auth token
  (`<sessionToken>.<base64Signature>`) contains `.`, `+`, `/` and `=`, illegal in an RFC 6455
  subprotocol token ([shared/ws-bearer.ts](../../../shared/ws-bearer.ts)).
- **The carrier exists** because RFC 6455 requires the server to echo one offered subprotocol for
  strict clients, and echoing the _bearer_ would expose the credential on `WebSocket.protocol` to
  page JS and response logs ([ws.ts:237-259](../../../backend/src/proxy/ws.ts#L237)).
- **The bearer is validated in `open()`, not `beforeHandle`**, which Elysia/Bun can invoke more than
  once per upgrade and so holds only synchronous, idempotent target checks. `open()` runs once per
  accepted socket, validates through the Better Auth path REST uses, and refuses anonymous users
  ([ws.ts:276-293](../../../backend/src/proxy/ws.ts#L276),
  [backend/src/auth/ws-bearer-auth.ts](../../../backend/src/auth/ws-bearer-auth.ts)).
- **The whole `tbproxy.*` and `thunderbolt.*` namespace is stripped before the upstream handshake**
  ([ws.ts:86](../../../backend/src/proxy/ws.ts#L86)); caller protocols pass through so the upstream
  negotiates normally.
- Messages arriving before the upstream socket opens are queued and flushed on `open`.

`createProxyWebSocket` reads Use Cloud Proxy for each connection. Tauri defaults to direct
`new WebSocket(url, protocols)` with no app bearer; enabling the setting uses the same carrier,
bearer and target subprotocols as web. Tauri loopback targets always stay direct; web always proxies.
The proxy accepts only public `wss://` targets: `ws://` and private-network targets get HTTP 400,
without upgrading the scheme or falling back to direct. LAN agents need a `wss://` address with
Use Cloud Proxy off on desktop/mobile. Plain `ws://` works only for a local bridge at its default
port (`8839`) on the same computer as the desktop app. Managed ACP and iroh routing are separate
and unchanged.

### Close codes

| Code   | Meaning                                                               |
| ------ | --------------------------------------------------------------------- |
| `4001` | Upgrade accepted, then refused: bearer missing, invalid, or anonymous |
| `4002` | Target subprotocol unparseable at `open()` time                       |
| `4003` | Reserved for a non-`wss://` target; classified but not emitted today  |
| `4008` | Pre-connect queue exceeded its message or byte budget                 |
| `1011` | Upstream connection failed or errored                                 |

Otherwise the upstream's close code and reason are relayed verbatim. An unparseable subprotocol or
invalid target is caught earlier, in `beforeHandle`, and refused with an HTTP 400, so the client
sees a failed handshake (`1002`/`1006`) rather than a close code. `4001`, in the app-defined
4000-4999 range, distinguishes "accepted my socket, then refused me" (re-login) from "never reached
the server" (network error).

`/v1/proxy/ws` is exempt from the minimum-app-version gate: a browser cannot attach `X-App-Version`
to a handshake. `/v1/proxy` is gated normally, so the client adds the header to the outer hop.

## Auth, rate limiting, observability

| Route          | Auth                                 | Rate limit                                   |
| -------------- | ------------------------------------ | -------------------------------------------- |
| `/v1/proxy`    | `guard({ auth: true })`, any session | `pro` tier, 100 req/min keyed on `user:<id>` |
| `/v1/proxy/ws` | Bearer validated in `open()`         | Same limiter mounted, but not user-limited   |

The WS handshake is not user-limited because the limiter keys on the `user` the auth macro
resolves, and the WS bearer is authorized inside `open()`. Full per-route inventory:
[backend-api-surface.md](backend-api-surface.md).

Each request emits one `proxy_request` (or `proxy_ws_relay`) Pino event and matching `proxy.*`
attributes on the active OpenTelemetry span, from the response stream's completion callback, so
byte counts and timings match what the caller received. Nothing goes to PostHog: the proxy is
infrastructure, not a product event surface.

Failures carry a categorical `error_type`, so a client mistake, an upstream outage and an
exfiltration attempt stay distinguishable: `ssrf`, `dns_timeout`, `idle_timeout`, `cap_exceeded`,
`upstream_4xx`, `upstream_5xx`, `invalid_target`, plus `auth_reject` (declared in the enum, not
emitted by either proxy path today).

## The client side: which fetch to use

Four entry points, not interchangeable:

| Use it for                                       | Entry point                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An authenticated call to our own backend         | `useHttpClient()` ([src/contexts/http-client-context.tsx](../../../src/contexts/http-client-context.tsx)), or `createAuthenticatedClient` ([src/lib/http.ts:185](../../../src/lib/http.ts#L185)) |
| An external API with no app headers or auth      | `http` ([src/lib/http.ts:267](../../../src/lib/http.ts#L267))                                                                                                                                    |
| Own-key model inference/catalogs or MCP HTTP/SSE | `useFetch()` / `useProxyFetchGetter()` (React), `createProxyFetch()` (non-React) ([src/lib/proxy-fetch-context.tsx](../../../src/lib/proxy-fetch-context.tsx))                                   |
| A loopback model that must stay device-direct    | `fetch` from [src/lib/fetch.ts](../../../src/lib/fetch.ts)                                                                                                                                       |

- **`createAuthenticatedClient` is the only path** injecting `X-Device-ID`, `X-Device-Name`,
  `X-App-Version` and `X-App-Language`, and the only one turning a 426 into the upgrade blocker. It
  also turns a 401 into a `powersync_credentials_invalid` event; backend calls that bypass it (chat,
  voice, the built-in agent, the proxy's own auth gate) do the same through `handleSessionRejected`
  ([src/lib/session-rejected.ts](../../../src/lib/session-rejected.ts)). Those headers and both
  response hooks sit behind an origin-and-prefix guard (`isBackendRequest`), so the same client can
  call an external API without leaking identity headers or misreading a 401 as an expired session.
  The bearer is attached regardless of origin, and a caller-set `Authorization` is left alone.
- **`src/lib/fetch.ts` is the Tauri-aware escape hatch.** It uses browser fetch by default, or
  the shared native adapter on Tauri when the "Use Native Fetch" dev setting is on. Native HTTP
  is registered unconditionally.

### Hosted and Standalone

`createProxyFetch` selects the route per request ([src/lib/proxy-fetch.ts](../../../src/lib/proxy-fetch.ts)):

- **Hosted** wraps the request for `${cloudUrl}/proxy`. Web always uses it; Tauri desktop and
  mobile opt in with **Use Cloud Proxy** (`proxy_enabled=true`). The hosted hop includes backend
  session credentials (`credentials: 'include'`, including cookie-only SSO) and the app-version header.
- **Standalone** sends directly from the device through Tauri's HTTP plugin when the setting is
  OFF or absent. Native HTTP ships on every Tauri build, without a persisted cookie jar,
  and trusts OS certificates alongside bundled public roots.
  Native failures propagate without a backend retry. Public `http:` targets are upgraded to
  `https:`; local/private IPs, `host.docker.internal`, `.local` and `*.localhost` names keep HTTP.
  Arbitrary split-DNS private FQDNs are upgraded too; the hosted proxy also upgraded and SSRF-blocked them.
- **Native requests never follow redirects, for all methods** (`maxRedirections: 0`), because
  reqwest retains provider-specific credentials such as `x-api-key` across redirects. Enter the
  final endpoint URL. Hosted redirect handling is unchanged. Both native entry points use
  `src/lib/native-fetch.ts`, which normalizes plugin request/body failures to `TypeError('Failed to fetch')`
  and relays cancellation through a per-request child signal. `init.signal` takes precedence over
  a `Request` signal, including explicit `null`; completion, failure and cancellation detach the relay.
- **Custom loopback models always stay device-direct** through `src/lib/fetch.ts`, on web and Tauri.
  Remote ACP WebSockets follow Use Cloud Proxy on Tauri, with loopback always direct; Tinfoil keeps its attested client.

`computeEffectiveProxyEnabled` is the shared policy. The preferences switch shows the effective
value, permits turning it off while signed out, and requires sign-in to enable it. Web shows it
on and disabled. A signed-out user with Cloud Proxy on gets backend 401s until they turn it off
or sign in.

### Outer-hop headers must not be promoted

`skipHeaders` ([src/lib/proxy-fetch.ts:64-85](../../../src/lib/proxy-fetch.ts#L64)) never promotes:

- Browser-injected noise (`origin`, `referer`, the `sec-*` family), which would leak browser
  context upstream.
- `x-app-version` and `x-app-language`, which belong to the hop between the app and _our_ backend;
  promoting them would ship them to an external LLM or MCP provider. The proxy fetch sets
  `X-App-Version` on the outer request itself, after the promotion step
  ([AGENTS.md](../../../AGENTS.md), "The `X-App-Language` header").

### A 426 must be matched on the body, not the status

Upstream status codes are relayed verbatim, so a provider answering `426 Upgrade Required` looks
exactly like our version gate and acting on the status would blank the whole app. Only our gate
pairs 426 with an `APP_VERSION_UNSUPPORTED` body code, so that code is the discriminator
([src/lib/proxy-fetch.ts](../../../src/lib/proxy-fetch.ts)); the check reads a clone, so
the body still reaches the caller intact. On the direct-to-backend path in `src/lib/http.ts` the
status _is_ sufficient: no upstream to confuse it with. Native provider responses never run
backend session-rejection or upgrade handling, even if their 401/426 bodies imitate backend codes.

### `useFetch()` versus `useProxyFetchGetter()`

The provider memoises one `proxyFetch` per `cloudUrl`. Each request reads the current
`proxy_enabled` setting, so even a fetch captured by the Pi harness follows toggle changes.
`useProxyFetchGetter()` is a ref-backed getter for callers that also need a changed `cloudUrl`
without recreating their chat ([src/lib/proxy-fetch-context.tsx](../../../src/lib/proxy-fetch-context.tsx));
hence the model factory takes `getProxyFetch: () => FetchFn`.

## Where the code lives

| Piece                       | File                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------- |
| HTTP route, redirect loop   | [backend/src/proxy/routes.ts](../../../backend/src/proxy/routes.ts)                 |
| WebSocket relay             | [backend/src/proxy/ws.ts](../../../backend/src/proxy/ws.ts)                         |
| Byte cap and idle watchdog  | [backend/src/proxy/streaming.ts](../../../backend/src/proxy/streaming.ts)           |
| Logging and OTel attributes | [backend/src/proxy/observability.ts](../../../backend/src/proxy/observability.ts)   |
| DNS pinning, SSRF checks    | [backend/src/utils/url-validation.ts](../../../backend/src/utils/url-validation.ts) |
| Header names, dropped sets  | [shared/proxy-protocol.ts](../../../shared/proxy-protocol.ts)                       |
| WS bearer codec, carrier    | [shared/ws-bearer.ts](../../../shared/ws-bearer.ts)                                 |
| WS bearer validation        | [backend/src/auth/ws-bearer-auth.ts](../../../backend/src/auth/ws-bearer-auth.ts)   |
| Client fetch and WS factory | [src/lib/proxy-fetch.ts](../../../src/lib/proxy-fetch.ts)                           |
| React provider and hooks    | [src/lib/proxy-fetch-context.tsx](../../../src/lib/proxy-fetch-context.tsx)         |
| Mount and rate-limit wiring | [backend/src/index.ts:128-162](../../../backend/src/index.ts#L128)                  |

### Coverage

| Suite                                                | Covers            |
| ---------------------------------------------------- | ----------------- |
| `backend/src/proxy/routes.test.ts`, `e2e.test.ts`    | The HTTP contract |
| `ws.test.ts`, `ws-e2e.test.ts`                       | The relay         |
| `streaming.test.ts`                                  | The caps          |
| `observability.test.ts`, `observability.e2e.test.ts` | The event shape   |

`ws-e2e.test.ts` runs in its own CI step, once with retries rather than the 5x rerun the rest of the
backend suite gets, because same-process Bun WS event delivery is flaky under load
([.github/workflows/ci.yml](../../../.github/workflows/ci.yml)).

The Playwright specs `e2e/proxy-fetch.spec.ts`, `e2e/proxy-passthrough-headers.spec.ts`,
`e2e/proxy-mcp.spec.ts` and `e2e/proxy-websocket.spec.ts` pin the browser-side wire format against a
stubbed transport (`page.route()` for the HTTP specs, a `globalThis.WebSocket` stub for the relay
spec), because the backend's SSRF guard blocks loopback upstreams and no real upstream can be stood
up in dev.
