# RESEARCH-001: Desktop OAuth via Localhost Loopback

**Issue:** THU-302 -- Google Connect not working on desktop
**Date:** 2026-02-25
**Status:** Ready for implementation

---

## 1. Problem Statement

Google blocks OAuth in embedded webviews (policy effective Jan 2021). The current implementation opens Google's OAuth URL inside a Tauri `WebviewWindow`, which triggers "Error 400: invalid_request / Access blocked: Authorization Error". Microsoft may enforce similar restrictions in the future.

## 2. Technology Choice Analysis

### Option A: Localhost Loopback Server (SELECTED)

Uses `@fabianlars/tauri-plugin-oauth` to spawn a temporary HTTP server on `127.0.0.1`, then opens the system browser for OAuth. The OAuth provider redirects back to `http://localhost:{port}`, which the loopback server captures.

**Pros:**
- Google explicitly supports `http://localhost` redirect URIs for native apps (RFC 8252, Section 7.3)
- No custom URI scheme registration needed per-platform
- The plugin is maintained, Tauri v2 compatible, small (~200 lines of Rust)
- System browser has cookies, password managers, and security indicators the user trusts
- Single-request server: accepts one redirect then shuts down, minimizing attack surface

**Cons:**
- Requires an open port on localhost (mitigated by trying 3 preferred ports with fallback)
- Requires adding a Rust dependency (~200 lines, transitive deps: `httparse` and `url`)

### Option B: Custom URI Scheme (REJECTED)

Register a custom protocol handler (e.g., `thunderbolt://oauth/callback`) and use deep links.

**Cons:**
- Already used for mobile (App Links / Universal Links) -- mixing schemes adds complexity
- Custom URI schemes require per-platform registration (Info.plist on macOS, registry on Windows)
- Some OAuth providers do not accept custom URI schemes for desktop apps
- Google specifically recommends loopback for desktop native apps in their OAuth documentation
- Deep link registration can conflict with other apps using the same scheme

### Option C: Manual Copy-Paste Code (REJECTED)

Display the auth code for the user to copy-paste back into the app.

**Cons:**
- Terrible UX; violates "bias towards tasteful simplicity"
- Error-prone; users mistype or paste partial codes

**Decision: Option A (localhost loopback) is the standard, Google-recommended approach for desktop native apps.**

## 3. Plugin API Reference

Package: `@fabianlars/tauri-plugin-oauth@2` (npm) / `tauri-plugin-oauth = "2"` (Cargo)

### TypeScript Guest Bindings (from source: `guest-js/index.ts`)

```typescript
import { start, cancel, onUrl, onInvalidUrl } from '@fabianlars/tauri-plugin-oauth'

type OauthConfig = {
  ports?: number[]    // Preferred ports to try; falls back to OS-assigned if omitted
  response?: string   // Custom HTML response shown to user after redirect capture
}

start(config?: OauthConfig): Promise<number>                    // Returns port
cancel(port: number): Promise<void>                             // Stops server
onUrl(cb: (url: string) => void): Promise<() => void>           // Returns unlisten fn
onInvalidUrl(cb: (err: string) => void): Promise<() => void>    // Returns unlisten fn
```

### Rust Plugin Init

```rust
builder = builder.plugin(tauri_plugin_oauth::init());
```

### Capabilities/Permissions

The plugin exposes two IPC commands. There is NO `oauth:default` permission set; both must be listed explicitly:
- `oauth:allow-start`
- `oauth:allow-cancel`

### How the Server Works (from Rust source analysis)

1. `start()` binds a `TcpListener` to `127.0.0.1:{port}` and spawns a thread
2. When the browser redirects to `http://localhost:{port}/?code=X&state=Y`, the server:
   - Serves an HTML response with an injected `<script>` that fetches `/cb` with a `Full-Url` header containing `window.location.href`
   - On the `/cb` request, extracts the full URL from the `Full-Url` header and emits an `oauth://url` Tauri event
3. The server accepts ONE connection cycle then exits its loop
4. `cancel(port)` sends a magic `[1,3,3,7]` byte sequence to the port to trigger shutdown

### Key Insight: Two-Phase URL Capture

The plugin uses a two-phase approach. The initial HTTP request to `localhost:{port}` only has the path (e.g., `/?code=X`), not the full URL with scheme and host. The injected script runs in the browser context where `window.location.href` is available, then fetches `/cb` with the full URL in a custom `Full-Url` header. This means the `onUrl` callback receives the COMPLETE URL including all query parameters.

## 4. Module Design: `src/lib/oauth-loopback.ts`

### Async Flow

```
1.  Generate state (uuid) + PKCE (codeVerifier, codeChallenge)
2.  start({ ports: [17421, 17422, 17423], response: COMPLETION_HTML }) --> port
3.  Build redirectUri = `http://localhost:${port}`
4.  Register onUrl listener BEFORE opening browser (avoid race condition)
5.  buildAuthUrl(provider, state, codeChallenge, redirectUri) --> authUrl
6.  openUrl(authUrl) --> opens system browser
7.  Await Promise.race([onUrl promise, timeout promise])
8.  Parse code + state from callback URL
9.  Validate state matches
10. exchangeCodeForTokens(provider, code, codeVerifier, redirectUri) --> tokens
11. getUserInfo(provider, tokens.access_token) --> userInfo
12. Return { tokens, userInfo }
13. FINALLY: cancel(port) + unlisten() (always, even on error/timeout)
```

### Port Selection Rationale

Ports `[17421, 17422, 17423]` are chosen because:
- They are outside the IANA well-known range (0-1023) and common service range
- They are not used by any widely-known service
- Google Cloud Console requires pre-registered redirect URIs with exact port matching
- Three ports provide resilience if one is occupied by another process
- The plugin's `start()` tries each port in order and binds to the first available

Google Cloud Console redirect URI registrations needed:
- `http://localhost:17421`
- `http://localhost:17422`
- `http://localhost:17423`

### Completion HTML

A self-contained HTML page shown to the user after the redirect is captured. Must contain a `<head>` element so the plugin can inject its script tag. The page should:
- Display a success message
- Instruct the user to return to Thunderbolt
- Be visually branded (inline CSS, no external resources)

### Timeout

A 5-minute timeout prevents indefinite hanging if the user abandons the browser flow. Implemented via `Promise.race` between the `onUrl` promise and a timeout rejection.

### Return Type

Same as `startOAuthFlowWebview`: `Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo } | null>`

Returns `null` only if the flow times out or is otherwise cancelled (not on error -- errors are thrown).

## 5. Signature Changes

### `src/integrations/google/auth.ts`

```typescript
// BEFORE
export const buildAuthUrl = async (state: string, codeChallenge: string): Promise<string>
export const exchangeCodeForTokens = async (code: string, codeVerifier: string): Promise<OAuthTokens>

// AFTER -- add optional redirectUri override
export const buildAuthUrl = async (state: string, codeChallenge: string, redirectUri?: string): Promise<string>
export const exchangeCodeForTokens = async (code: string, codeVerifier: string, redirectUri?: string): Promise<OAuthTokens>
```

Implementation detail: When `redirectUri` is provided, it overrides `config.redirectUri` in the URL construction and token exchange request. When omitted, behavior is unchanged (uses `getOAuthRedirectUri()` via `getOAuthConfig()`). This preserves backward compatibility with all existing call sites (web flow, mobile flow).

### `src/integrations/microsoft/auth.ts`

Identical change:

```typescript
export const buildAuthUrl = async (state: string, codeChallenge: string, redirectUri?: string): Promise<string>
export const exchangeCodeForTokens = async (code: string, codeVerifier: string, redirectUri?: string): Promise<OAuthTokens>
```

### `src/lib/auth.ts` (provider-agnostic wrappers)

```typescript
// BEFORE
export const buildAuthUrl = async (provider: OAuthProvider, state: string, codeChallenge: string): Promise<string>
export const exchangeCodeForTokens = async (provider: OAuthProvider, code: string, codeVerifier: string): Promise<OAuthTokens>

// AFTER
export const buildAuthUrl = async (provider: OAuthProvider, state: string, codeChallenge: string, redirectUri?: string): Promise<string>
export const exchangeCodeForTokens = async (provider: OAuthProvider, code: string, codeVerifier: string, redirectUri?: string): Promise<OAuthTokens>
```

These just pass through the `redirectUri` to the provider-specific functions.

### `src/lib/oauth-redirect.ts`

No changes. The loopback flow bypasses `getOAuthRedirectUri()` entirely by constructing its own `redirectUri` from the loopback port. The web and mobile flows continue to use `getOAuthRedirectUri()` unchanged.

## 6. Hook Changes: `src/hooks/use-oauth-connect.ts`

### Import Change

```typescript
// BEFORE
import { startOAuthFlowWebview } from '@/lib/oauth-webview'

// AFTER
import { startOAuthFlowLoopback } from '@/lib/oauth-loopback'
```

### Dependencies Type Change

```typescript
// BEFORE
type OAuthDependencies = {
  startOAuthFlowWebview?: typeof startOAuthFlowWebview
  redirectOAuthFlow?: typeof redirectOAuthFlow
  exchangeCodeForTokens?: typeof exchangeCodeForTokens
  getUserInfo?: typeof getUserInfo
}

// AFTER
type OAuthDependencies = {
  startOAuthFlowLoopback?: typeof startOAuthFlowLoopback
  redirectOAuthFlow?: typeof redirectOAuthFlow
  exchangeCodeForTokens?: typeof exchangeCodeForTokens
  getUserInfo?: typeof getUserInfo
}
```

### Destructuring Change

```typescript
// BEFORE
const {
  startOAuthFlowWebview: startFlow = startOAuthFlowWebview,
  ...
} = dependencies || {}

// AFTER
const {
  startOAuthFlowLoopback: startLoopback = startOAuthFlowLoopback,
  ...
} = dependencies || {}
```

### Desktop Branch Change (inside `connect`)

```typescript
// BEFORE (lines 206-221)
} else {
  // For desktop: Use webview flow
  const result = await startFlow(provider)
  if (!result) {
    clearConnecting(key)
    return
  }
  const { tokens, userInfo } = result
  await saveOAuthCredentials(provider, tokens, userInfo, { setPreferredName })
  clearConnecting(key)
  onSuccess?.()
}

// AFTER
} else {
  // For desktop: Use loopback flow (system browser + localhost server)
  const result = await startLoopback(provider)
  if (!result) {
    clearConnecting(key)
    return
  }
  const { tokens, userInfo } = result
  await saveOAuthCredentials(provider, tokens, userInfo, { setPreferredName })
  clearConnecting(key)
  onSuccess?.()
}
```

The logic is structurally identical -- only the function name changes. `startOAuthFlowLoopback` returns the same `{ tokens, userInfo } | null` shape.

### Mobile Branch

UNCHANGED. Mobile continues to use `openUrl(authUrl)` with App Links / Universal Links.

## 7. Tauri/Rust Changes

### `src-tauri/Cargo.toml`

Add to `[dependencies]`:
```toml
tauri-plugin-oauth = "2"
```

### `src-tauri/src/lib.rs`

Add to the plugin chain after `tauri_plugin_deep_link::init()`:
```rust
.plugin(tauri_plugin_oauth::init())
```

### `src-tauri/capabilities/default.json`

Add to the `permissions` array:
```json
"oauth:allow-start",
"oauth:allow-cancel"
```

### `src-tauri/capabilities/auth.json`

DELETE this file entirely. It existed solely to grant permissions to `oauth-*` WebviewWindows. With the loopback approach, all OAuth IPC traffic originates from the main window, which is covered by `default.json`.

### WebviewWindow Permissions in `default.json`

The following permissions in `default.json` relate to webviews:
```
core:webview:allow-create-webview-window   -- creates a NEW window with a webview (OAuth only)
core:webview:allow-create-webview          -- creates a webview INSIDE an existing window
core:webview:allow-webview-size            -- reads webview size
core:webview:allow-webview-position        -- reads webview position
core:webview:allow-set-webview-size        -- sets webview size
core:webview:allow-set-webview-position    -- sets webview position
core:webview:allow-webview-close           -- closes a webview
```

**Assessment:** Only `core:webview:allow-create-webview-window` can be removed. The sidebar content preview feature (`src/content-view/use-sidebar-webview.ts`) uses `new Webview(window, label, options)` which requires `core:webview:allow-create-webview`, `allow-set-webview-size`, `allow-set-webview-position`, and `allow-webview-close`. These must be KEPT. The `core:window:allow-create` and `core:window:allow-close` permissions should also be KEPT as they apply to native OS windows.

## 8. Files to Delete

| File | Reason |
|---|---|
| `src/lib/oauth-webview.ts` | Replaced entirely by `src/lib/oauth-loopback.ts` |
| `src-tauri/capabilities/auth.json` | No more OAuth WebviewWindows |

## 9. Files to Create

| File | Purpose |
|---|---|
| `src/lib/oauth-loopback.ts` | Localhost loopback OAuth flow for desktop |

## 10. Files to Modify

| File | Change |
|---|---|
| `src/integrations/google/auth.ts` | Add optional `redirectUri` param to `buildAuthUrl` and `exchangeCodeForTokens` |
| `src/integrations/microsoft/auth.ts` | Same as google/auth.ts |
| `src/lib/auth.ts` | Pass through `redirectUri` in provider-agnostic wrappers |
| `src/hooks/use-oauth-connect.ts` | Replace webview import/usage with loopback |
| `src/hooks/use-oauth-connect.test.tsx` | Update mock dependency name from webview to loopback |
| `src-tauri/Cargo.toml` | Add `tauri-plugin-oauth = "2"` |
| `src-tauri/src/lib.rs` | Add `.plugin(tauri_plugin_oauth::init())` |
| `src-tauri/capabilities/default.json` | Add `oauth:allow-start`, `oauth:allow-cancel` |

## 11. Threat Model (STRIDE)

### Spoofing
- **Threat:** Attacker intercepts the OAuth redirect by running a server on the same port.
- **Mitigation:** PKCE (code_challenge + code_verifier) ensures that only the party that initiated the flow can exchange the code for tokens. Even if an attacker captures the auth code, they cannot use it without the code_verifier.
- **Mitigation:** The plugin binds to `127.0.0.1` (not `0.0.0.0`), so only local processes can connect.

### Tampering
- **Threat:** Attacker modifies the callback URL parameters.
- **Mitigation:** State parameter validation rejects tampered URLs. PKCE prevents code replay.

### Repudiation
- Not applicable for client-side OAuth.

### Information Disclosure
- **Threat:** Auth code visible in browser history/address bar.
- **Mitigation:** Auth codes are single-use and short-lived (typically 10 minutes). PKCE ensures they are useless without the verifier. The completion HTML page replaces the URL context.

### Denial of Service
- **Threat:** Port exhaustion -- all 3 preferred ports are occupied.
- **Mitigation:** The `start()` call throws an error, which is caught and surfaced to the user as a meaningful error message. Three port options provides reasonable resilience.
- **Threat:** Server hangs indefinitely.
- **Mitigation:** 5-minute timeout + `cancel(port)` in `finally` block ensures cleanup.

### Elevation of Privilege
- **Threat:** Malicious local app sends a crafted request to the loopback port.
- **Mitigation:** State validation + PKCE. The server only accepts one connection cycle and exits. The time window for attack is minimal (seconds between browser redirect and capture).

### Port Reuse
- **Threat:** After OAuth flow completes, another process binds to the now-free port.
- **Mitigation:** `cancel(port)` is called in a `finally` block immediately after the callback is received, shutting down the listener. The server's loop exits after handling one complete request cycle.

## 12. Implementation Order

1. Add Rust dependency + plugin init + capabilities (Rust/Tauri changes)
2. Add `redirectUri?` parameter to `google/auth.ts` and `microsoft/auth.ts` `buildAuthUrl` + `exchangeCodeForTokens`
3. Update provider-agnostic wrappers in `src/lib/auth.ts`
4. Create `src/lib/oauth-loopback.ts`
5. Update `src/hooks/use-oauth-connect.ts` to use loopback instead of webview
6. Update `src/hooks/use-oauth-connect.test.tsx` to reference loopback
7. Delete `src/lib/oauth-webview.ts`
8. Delete `src-tauri/capabilities/auth.json`
9. Test manually on macOS, Windows, and Linux
