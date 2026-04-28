# Unified Proxy

## Spec

### Overview

A single authenticated proxy replaces the three separate proxy endpoints (`/pro/proxy`, `/mcp-proxy`, `/agent-proxy`). All traffic — HTTP and WebSocket — flows through one route group at `/v1/proxy`, with one auth guard, one SSRF validator, and one rate limit.

Link preview metadata (`/pro/link-preview`) is **not** a proxy and stays as its own endpoint. Only its image sub-route (`/pro/link-preview/proxy-image`) is removed, replaced by the unified resource proxy.

On Tauri (desktop) and mobile, the proxy is bypassed entirely. Tauri's native HTTP and WebSocket APIs are used directly since CORS is not a browser constraint there. The frontend detects the platform and skips the proxy routes.

---

### Endpoints

#### `ALL /v1/proxy/{encodedTargetUrl}`

General-purpose HTTP proxy. Handles everything from `<img src>` favicon loading to MCP POST requests — one endpoint, one pattern.

- **Auth:** required (session cookie)
- **Target:** percent-encoded HTTPS URL in the path; the handler rejects non-`https://` targets with 400 (server-side enforcement, not just a client convention)
- **Method:** forwarded as-is (GET, POST, PUT, DELETE, PATCH, etc.)
- **Headers:** hop-by-hop headers stripped; `Authorization` always stripped — it is reserved for proxy authentication, regardless of mechanism (cookie today, Bearer in future) and must never reach upstream servers; clients that need to authenticate to an upstream server send `X-Upstream-Authorization`, which the proxy renames to `Authorization` before forwarding
- **Body:** forwarded as-is
- **Redirects:** followed transparently, up to 5 hops; each redirect target is independently DNS-resolved and SSRF-validated before following (prevents redirect-chain SSRF). `createSafeFetch` handles this — callers see the final response.
- **Response:** upstream status + body; upstream `content-type`/`cache-control`/`etag`/`last-modified` forwarded; `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` always added; upstream `Set-Cookie` stripped. (`Content-Disposition: attachment` does not affect `<img src>` or other sub-resource loads — browsers ignore it for embedded resources and it only matters for direct navigation.)
- **Limits:** 10 MB request body; 10 MB response body; 30 s timeout
- **SSRF:** DNS-pinned validation via `createSafeFetch`

#### `WS /v1/proxy/ws/{encodedTargetUrl}`

WebSocket relay.

- **Auth:** session cookie (sent automatically by the browser on same-origin WebSocket upgrades — no ticket needed)
- **Target:** percent-encoded `wss://` URL in the path
- **Relay:** bidirectional, no message transformation, no session management
- **Client auth:** the client passes its own `Authorization` via the WS subprotocol list if the upstream requires it — the proxy does not inject credentials. Note: credentials carried this way appear in the `Sec-WebSocket-Protocol` upgrade header, which may be logged by the upstream server or an inspecting network proxy — they are not hidden beyond TLS
- **Authorization header:** the upgrade request's `Authorization` header is stripped before opening the upstream connection, consistent with the HTTP proxy handler
- **Close propagation:** upstream close → downstream close, downstream close → upstream close
- **Limits:** 256 KB / 64 messages queued while upstream is connecting; if either limit is exceeded the downstream connection is closed with 4008 (policy violation) and the upstream connection attempt is aborted
- **Target:** only `wss://` URLs accepted; plain `ws://` rejected with 4003 (no plaintext WebSocket relay)
- **SSRF:** hostname-only validation via `validateSafeUrl` — since that function only accepts `http:`/`https:` protocols, the handler converts `wss://` → `https://` for validation only, then uses the original `wss://` URL for `new WebSocket()`. DNS-pinned WebSocket is not supported by Bun's WS API; this is a documented limitation — see [known limitations](#known-limitations)

---

### Proxy Toggle

A **"Route requests through proxy"** toggle lives in the settings screen. It controls a `proxy_enabled` boolean user preference (default: `true`).

| Platform | Toggle state | Behaviour |
|---|---|---|
| Web | Visible, disabled | Always proxied; CORS makes it non-negotiable |
| Tauri / mobile | Visible, interactive | User can disable to connect directly |

When disabled on Tauri, all proxy call sites use the raw target URL — no backend round-trip.

When hovered in the disabled (web) state, a tooltip reads: *"Proxying is required in the web app to bypass browser CORS restrictions."*

---

### Auth and Rate Limiting

All endpoints are guarded by the existing session auth middleware. The same `createProRateLimit` applied to `/pro` routes today is applied to the unified proxy, including the WebSocket upgrade.

`X-Upstream-Authorization` must be added to `corsAllowHeaders` in `backend/src/config/settings.ts` so CORS preflight passes when browser clients include it.

---

### Proxy Toggle and Tauri Bypass

A `proxy_enabled` boolean user setting controls whether the proxy is used. All proxied requests go through a single helper that consults this setting:

```ts
// src/lib/proxy.ts
export const resolveProxiedUrl = (targetUrl: string, proxyBase: string, proxyEnabled: boolean): string => {
  const useProxy = !isTauri() || proxyEnabled
  return useProxy ? `${proxyBase}/proxy/${encodeURIComponent(targetUrl)}` : targetUrl
}

export const resolveProxiedWsUrl = (targetUrl: string, proxyBase: string, proxyEnabled: boolean): string => {
  const useProxy = !isTauri() || proxyEnabled
  return useProxy ? `${proxyBase.replace(/^http/, 'ws')}/proxy/ws/${encodeURIComponent(targetUrl)}` : targetUrl
}
```

Both functions are used for all proxy call sites — GET resource loading (favicons, images), POST/PUT API proxying (MCP), and WebSocket relay (agents). There is no separate fast path for simple GETs.

**On web:** `!isTauri()` is true, so the setting is ignored and the proxy is always used. CORS makes this non-negotiable.

**On Tauri/mobile:** the setting is respected. Default is `true` (proxy on) so behaviour is unchanged out of the box; the user can disable it to connect directly and skip the round-trip.

The settings screen shows the toggle on all platforms. On web it is disabled with a tooltip: *"Proxying is required in the web app to bypass browser CORS restrictions."* On Tauri it is interactive. This follows the existing disabled-with-tooltip pattern used in `src/settings/dev-settings.tsx`.

---

### Known Limitations

**WebSocket SSRF — DNS rebinding gap.** The WS relay uses `validateSafeUrl` (hostname-only, synchronous) rather than DNS-pinned validation. A DNS rebinding attack could bypass this: attacker's hostname first resolves to a public IP (passes validation), then changes to an internal IP at connect time. The HTTP proxy does not have this gap (`createSafeFetch` resolves the IP before connecting and connects to the IP directly). Fixing the WS gap requires implementing a `createSafeWebSocket` helper that resolves DNS, validates, and connects to the IP with the original `Host` header — Bun does not support this natively today, so it's deferred. A network-level forward proxy (see [Forward Proxy](#forward-proxy-production-egress)) would close this gap at the infrastructure layer.

In practice, a successful DNS rebinding attack requires the attacker to control a domain and DNS server with very short TTLs and to time the rebind to the narrow window between validation and connect — all while holding a valid authenticated session. This is a realistic threat in high-value or enterprise deployments; operators in those environments should prioritise deploying the network-level forward proxy mitigation.

**Concurrent WebSocket connections.** The rate limit applies to the upgrade *request* but not to how many connections remain open simultaneously. An authenticated user who paces their upgrade requests within the rate window could hold a large number of open relays. This is accepted for now — the upstream server is responsible for its own connection limits. If this becomes a vector for resource exhaustion, add a per-user active-connection counter gated at upgrade time.

---

## Forward Proxy (Production Egress)

The unified proxy is designed so that egress traffic can optionally be routed through a network-level forward proxy (e.g. Squid, Envoy, a cloud NAT gateway) without changes to application logic. This is **not a current goal** — the application-level `createSafeFetch` SSRF guard is the primary defence today — but the architecture accommodates it.

### Why you might want this

- **Centralized egress control**: all outbound HTTP(S) from the backend leaves via one IP, making firewall rules and audit logs trivial.
- **Network-level SSRF defence**: a forward proxy configured to block RFC-1918 ranges closes the WebSocket DNS-rebinding gap (and provides defence-in-depth for HTTP).
- **Compliance / logging**: some enterprise deployments require all outbound traffic to pass through an inspecting proxy.

### How the architecture supports it

**HTTP requests** — `createProxyRoutes` accepts a `fetchFn` parameter. To route through a forward proxy, supply a `fetchFn` built around an `undici` `ProxyAgent` (or equivalent) pointed at the forward proxy address. The rest of the handler is unchanged. Example sketch:

```ts
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const agent = new ProxyAgent(process.env.EGRESS_PROXY_URL)
const fetchViaProxy = (url, init) => undiciFetch(url, { ...init, dispatcher: agent })

app.use(createProxyRoutes(auth, fetchViaProxy, rateLimit))
```

The `createSafeFetch` SSRF check can be retained (defence-in-depth) or relaxed if the forward proxy enforces its own denylist.

**WebSocket relay** — Bun's `new WebSocket()` does not support a proxy dispatcher natively. Options:
1. An OS-level transparent proxy (iptables `REDIRECT` or a `tproxy` rule) handles WS egress without any code change.
2. A `CONNECT`-tunnel-aware wrapper around a raw TCP socket could be introduced as `createSafeWebSocket` — this would also close the DNS-rebinding gap.

Until one of these is implemented, WebSocket egress bypasses any application-layer forward proxy. This should be documented in operator runbooks if a forward proxy is deployed.

### What would need to change

| Concern | Change required |
|---|---|
| HTTP egress via forward proxy | Inject `ProxyAgent`-backed `fetchFn` at startup (env var driven) |
| WS egress via forward proxy | OS-level transparent proxy, or implement `createSafeWebSocket` with `CONNECT` tunnelling |
| SSRF responsibility | Always retain both: app-level `createSafeFetch` check and forward proxy denylist. The cost of `createSafeFetch` is negligible; removing it creates a single point of failure if the forward proxy is misconfigured or bypassed |
| Auth header confidentiality | If the forward proxy TLS-inspects traffic, the upstream `Authorization` header becomes visible to it — document and accept, or use a non-inspecting proxy |

### Current status

Not implemented. The `fetchFn` injection point exists today; no operator-facing configuration is wired up. The pattern above is the intended path when this becomes a requirement.

---

## High-Level Changes

### Backend

1. **Create `backend/src/proxy/`** — new route module containing the unified HTTP proxy handler and WebSocket relay.

2. **Delete `backend/src/pro/proxy.ts`** and its test — replaced by the new unified proxy.

3. **Delete `backend/src/mcp-proxy/`** (routes + tests) — clients move to `ALL /v1/proxy/{encodedFullUrl}` (path-based target).

4. **Delete `backend/src/agent-proxy/`** (routes + tests) — stripped of all API key injection and ACP session logic, the relay is re-implemented cleanly inside the unified proxy.

5. **Delete `backend/src/auth/ws-ticket-routes.ts`** and its tests, and **delete `backend/src/auth/ws-ticket.ts`** and its tests. The ticket mechanism existed to authenticate WebSocket connections that can't carry custom headers, and to carry API keys for injection. Both reasons are now gone: the WS endpoint uses cookie auth (same-origin), and API key injection is removed. No other code references these files once the agent proxy is deleted.

6. **Update `backend/src/pro/link-preview.ts`** — remove the `/proxy-image/*` sub-route. The upstream image URL is returned in the metadata response as-is; the frontend is responsible for routing it through the unified proxy.

7. **Update `backend/src/pro/routes.ts`** — remove `createProxyRoutes` and `createLinkPreviewRoutes` imports/usage (the proxy is gone, link-preview routes are restructured).

8. **Update `backend/src/index.ts`** — remove `createMcpProxyRoutes` and `createAgentProxyRoutes` mounts; add `createProxyRoutes` from the new module.

### Frontend

9. **New `src/lib/proxy.ts`** — `resolveProxiedUrl` and `resolveProxiedWsUrl` helpers (see spec above). All proxy URL construction moves here; no caller builds proxy URLs manually.

10. **Update `src/lib/url-utils.ts`** — `getProxiedFaviconUrl` delegates to `resolveProxiedUrl`, removing its own `isTauri()` logic.

11. **Update `src/widgets/link-preview/widget.tsx`** — image URL construction uses `resolveProxiedUrl`.

12. **Update MCP client code** — replace `X-Mcp-Target-Url` header + `/mcp-proxy/subpath` pattern with path-based encoding: client builds the full target URL (base + subpath), percent-encodes it, and routes to `POST /v1/proxy/{encodedFullUrl}`. No custom target header is used.

13. **Update agent/WS client code** — remove ticket issuance step; connect directly to `resolveProxiedWsUrl(targetUrl, proxyBase, proxyEnabled)`, which on Tauri (with proxy off) is the raw `wss://` URL and on web is the `/proxy/ws/{encodedUrl}` route.

14. **New `proxy_enabled` setting** — add default in `src/defaults/settings.ts` (`proxy_enabled: true`), wire into `useSettings` hook. All proxy callers read `proxyEnabled.value` and pass it to the helpers.

15. **Settings UI** — add a "Proxy" toggle to `src/settings/preferences.tsx`. Disabled on web with tooltip following the `dev-settings.tsx` pattern:
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <span>
      <Switch
        checked={proxyEnabled.value}
        onCheckedChange={proxyEnabled.setValue}
        disabled={!isTauri()}
      />
    </span>
  </TooltipTrigger>
  {!isTauri() && (
    <TooltipContent sideOffset={4}>
      Proxying is required in the web app to bypass browser CORS restrictions.
    </TooltipContent>
  )}
</Tooltip>
```

---

## Exact Changes

### Delete

```
backend/src/pro/proxy.ts
backend/src/pro/proxy.test.ts
backend/src/mcp-proxy/routes.ts
backend/src/mcp-proxy/routes.test.ts
backend/src/agent-proxy/routes.ts
backend/src/agent-proxy/routes.test.ts
backend/src/auth/ws-ticket.ts
backend/src/auth/ws-ticket.test.ts
backend/src/auth/ws-ticket-routes.ts
backend/src/auth/ws-ticket-routes.test.ts
```

Before deleting, grep for any barrel `index.ts` files that re-export from these paths — a missing re-export removal will cause a TypeScript error without a clear pointer to the deleted file.

---

### New: `backend/src/proxy/routes.ts`

Single Elysia plugin exported as `createProxyRoutes(auth, fetchFn, rateLimit?)`.

**Imports:** `createAuthMacro`, `createSafeFetch`, `validateSafeUrl`, `filterHeaders`, `extractResponseHeaders`, Elysia.

**Shared constants:**
```ts
const maxBodyBytes = 10 * 1024 * 1024   // 10 MB
const proxyTimeoutMs = 30_000

const wsMaxPendingMessages = 64
const wsMaxPendingBytes = 256 * 1024
```

**Shared request denylist** (hop-by-hop + forwarding headers):
```ts
const requestDenylist = [
  'host', 'connection', 'transfer-encoding', 'upgrade',
  'content-length', 'cookie', 'authorization', /^proxy-/i, /^x-forwarded-/i, 'x-real-ip',
]
```

**`ALL /proxy/{encodedUrl}`** — decodes URL from path (400 on bad encoding), rejects non-`https://` targets (400), SSRF-validates via `createSafeFetch`, strips denylist headers, renames `X-Upstream-Authorization` → `Authorization` if present, buffers request body (413 if > 10 MB), calls `safeFetch` with forwarded method/headers/body, buffers response (502 if > 10 MB), returns with security headers.

**`WS /proxy/ws/{encodedUrl}`** — on open: checks session auth first (4001 if unauthenticated), then decodes URL, rejects non-`wss://` targets (4003), and runs `validateSafeUrl` on the URL with `wss://` swapped to `https://` (4003 if blocked or bad encoding). Auth is checked before SSRF validation so unauthenticated clients cannot probe which hostnames are blocked. Opens upstream `new WebSocket(url, clientSubprotocols)` using the original `wss://` URL — subprotocols passed through as-is so the client can convey its own auth. Message queueing logic (CONNECTING backlog) carried over from current agent proxy, sans API key injection and ACP session state. On close: upstream close → downstream close and vice versa. No HTTP/SSE relay — that mode existed solely for API key injection and is removed.

> Note: the HTTP/SSE relay mode in the current agent proxy exists solely to support API key injection over SSE. Without key injection, agents use standard WebSocket. Drop the HTTP relay entirely.

---

### New: `backend/src/proxy/routes.test.ts`

Tests covering:
- `ALL /proxy/{encodedUrl}`: GET happy path, POST with body forwarded, bad encoding, non-HTTPS target rejected (400), SSRF-blocked IP, upstream 4xx/5xx, request too large, response too large, `Authorization` stripped and not forwarded, `X-Upstream-Authorization` renamed to `Authorization` before forwarding, hop-by-hop headers stripped, unauthenticated, redirect followed and final response returned, redirect to private IP blocked
- `WS /proxy/ws/{encodedUrl}`: bad encoding, plain `ws://` target rejected (4003), SSRF-blocked URL, unauthenticated, upstream close propagation, message relay, subprotocol passthrough

---

### Modify: `backend/src/index.ts`

Remove:
```ts
import { createAgentProxyRoutes } from '@/agent-proxy/routes'
import { createMcpProxyRoutes } from '@/mcp-proxy/routes'
import { createWsTicketRoutes } from '@/auth/ws-ticket-routes'
```

Add:
```ts
import { createProxyRoutes } from '@/proxy/routes'
```

Replace `.use(createMcpProxyRoutes(...))`, `.use(createAgentProxyRoutes())`, and `.use(createWsTicketRoutes(...))` with:
```ts
.use(createProxyRoutes(auth, fetchFn, createProRateLimit(database, rateLimitSettings)))
```

---

### Modify: `backend/src/pro/routes.ts`

Remove the `createProxyRoutes` import and `.use(createProxyRoutes(fetchFn))` line. The generic proxy is gone from the pro route group.

---

### Modify: `backend/src/pro/link-preview.ts`

Remove the `/proxy-image/*` route handler and `fetchAndProxyImage` helper entirely. The metadata endpoint (`GET /link-preview/*`) continues to return the raw `og:image` URL in its response — the frontend is responsible for routing the image through `/proxy/{encodedUrl}`.

---

### New: `src/lib/proxy.ts`

```ts
import { isTauri } from '@/lib/platform'

export const resolveProxiedUrl = (targetUrl: string, proxyBase: string, proxyEnabled: boolean): string => {
  if (!isTauri() || proxyEnabled) return `${proxyBase}/proxy/${encodeURIComponent(targetUrl)}`
  return targetUrl
}

export const resolveProxiedWsUrl = (targetUrl: string, proxyBase: string, proxyEnabled: boolean): string => {
  if (!isTauri() || proxyEnabled) return `${proxyBase.replace(/^http/, 'ws')}/proxy/ws/${encodeURIComponent(targetUrl)}`
  return targetUrl
}
```

`proxyBase` must include the API version prefix (e.g. `/api/v1`), so that the constructed path matches the `/v1/proxy/{encodedTargetUrl}` mount point. Call sites should pass `getApiBase()` or equivalent — never a bare origin.

---

### New: `proxy_enabled` setting

In `src/defaults/settings.ts`, add:
```ts
export const defaultSettingProxyEnabled: Setting = {
  key: 'proxy_enabled',
  value: 'true',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}
```

Add to the `defaultSettings` array.

---

### Modify: `src/lib/url-utils.ts`

Replace the body of `getProxiedFaviconUrl` with a call to `resolveProxiedUrl`. Remove the direct `isTauri()` check — that logic now lives in `proxy.ts`.

---

### Modify: `src/widgets/link-preview/widget.tsx`

Replace manual proxy URL construction with `resolveProxiedUrl`. Remove the `/pro/link-preview/proxy-image/` prefix from all URL construction.

---

### Modify: `src/settings/preferences.tsx`

Add a proxy toggle, reading `proxyEnabled` from `useSettings({ proxy_enabled: true })`. Follow the disabled-with-tooltip pattern from `dev-settings.tsx` (wrap in `<Tooltip>`, disable when `!isTauri()`, show `<TooltipContent>` only when disabled).

---

### Modify: MCP client code (unmerged branch)

Find all call sites that set `X-Mcp-Target-Url` and route to `/mcp-proxy/*`. Replace with:
- Route: `/proxy/{encodedFullUrl}` (client constructs base + subpath, encodes, and puts it in the path)
- Remove the `X-Mcp-Target-Url` header and subpath-appending logic — client builds the full URL
- If the MCP server requires auth, send `X-Upstream-Authorization: Bearer <token>` — the proxy strips `Authorization` and will never forward it, so this header is the only way to pass credentials to upstream

---

### Modify: Agent/WS client code (unmerged branch)

Find all call sites that POST to `/ws-ticket` and connect to `/agent-proxy/ws`:
- Remove the ticket issuance HTTP call entirely
- Connect directly to `/proxy/ws/{encodedTargetUrl}` — the session cookie authenticates the upgrade
- Client is responsible for its own upstream auth (pass via subprotocol if needed)
