# PROPOSAL-001: Fix Google Connect on Desktop (THU-302)

**Project:** THU-302
**Author:** Product Owner
**Date:** 2026-02-25
**Status:** Draft

---

## Problem Statement

The "Connect Google" button in the Thunderbolt desktop app (Tauri) displays the following error when clicked:

> Access blocked: Authorization Error
> Error 400: invalid_request

**Root cause:** The current implementation opens Google's OAuth authorization page inside a Tauri `WebviewWindow` (an embedded webview). Google has blocked OAuth flows inside embedded webviews since January 2021 as a security measure to prevent credential phishing. Microsoft enforces the same restriction for their OAuth endpoints.

**Current broken flow (desktop):**

1. User clicks "Connect Google"
2. `use-oauth-connect.ts` calls `startOAuthFlowWebview()` from `src/lib/oauth-webview.ts`
3. `oauth-webview.ts` creates a `WebviewWindow` pointed at `https://accounts.google.com/o/oauth2/v2/auth`
4. Google detects embedded webview and rejects with `Error 400: invalid_request`

**Correct flow (to be implemented):**

1. User clicks "Connect Google"
2. App starts a localhost loopback server (pre-registered port from `[17421, 17422, 17423]`) via `tauri-plugin-oauth`
3. App opens the system browser with a `redirect_uri` of `http://127.0.0.1:<port>`
4. User signs in with Google in their own browser
5. Google redirects to `http://127.0.0.1:<port>?code=...&state=...`
6. The loopback server receives the callback and emits a Tauri event
7. App validates state, exchanges the code for tokens, and completes the connection

---

## User Stories

### US-001: Desktop user connects Google account via system browser

**As a** desktop user,
**I want to** connect my Google account so that Thunderbolt can access my Gmail, Calendar, and Drive,
**So that** I can use Google-integrated features of the app.

**Acceptance criteria:**

- AC-001-1: Clicking "Connect Google" in the Thunderbolt desktop app no longer shows "Error 400: invalid_request" from Google.
- AC-001-2: After a successful connection, the Google integration tile shows the user's email address and a connected state.
- AC-001-3: The access token and refresh token are persisted in the app's local settings database.
- AC-001-4: After connecting, Gmail/Calendar/Drive tools are available in the AI assistant.

---

### US-002: Desktop user sees the system browser open (not an embedded window)

**As a** desktop user,
**When I** click "Connect Google",
**I want** my default system browser to open the Google sign-in page,
**So that** I trust the sign-in experience and Google accepts the authentication request.

**Acceptance criteria:**

- AC-002-1: Clicking "Connect Google" on desktop opens the OAuth URL in the system browser (Chrome, Firefox, Safari, etc.) rather than an embedded Tauri webview.
- AC-002-2: The Thunderbolt main window remains open and visible while the user completes sign-in in the browser.
- AC-002-3: No `WebviewWindow` is created for the OAuth flow on desktop.
- AC-002-4: The same behavior applies to "Connect Microsoft" on desktop.

---

### US-003: Desktop user is automatically returned to the app after sign-in

**As a** desktop user,
**After completing** Google sign-in in my browser,
**I want** Thunderbolt to automatically detect the callback and complete the connection,
**So that** I do not have to manually copy or paste any code or token.

**Acceptance criteria:**

- AC-003-1: After the user grants consent in the browser, Thunderbolt receives the authorization code without any manual user action.
- AC-003-2: The app shows the "Connecting..." loading state while the callback is in progress.
- AC-003-3: The "Connecting..." state clears automatically on both success and error.
- AC-003-4: The loopback server is always cleaned up (stopped) after the OAuth flow completes or errors, even if an exception is thrown.
- AC-003-5: If the user closes the browser tab without completing sign-in, the connecting state times out gracefully (existing 15-second timeout mechanism applies).

---

### US-004: Mobile flow is not affected

**As a** mobile user (iOS or Android),
**I want** the existing deep link / App Link OAuth flow to continue working exactly as before,
**So that** mobile users are not impacted by the desktop fix.

**Acceptance criteria:**

- AC-004-1: The mobile code path in `use-oauth-connect.ts` (`isMobile()` branch) is unchanged.
- AC-004-2: The `openUrl` + deep link callback mechanism on mobile continues to work.
- AC-004-3: `oauth-state.ts` (SQLite state storage for mobile callback validation) is unchanged.

---

### US-005: Web flow is not affected

**As a** web user (browser-based app),
**I want** the existing redirect-based OAuth flow to continue working exactly as before,
**So that** web users are not impacted by the desktop fix.

**Acceptance criteria:**

- AC-005-1: The web code path in `use-oauth-connect.ts` (`!isTauri()` branch using `redirectOAuthFlow`) is unchanged.
- AC-005-2: `getOAuthRedirectUri()` in `src/lib/oauth-redirect.ts` continues to return `window.location.origin + '/oauth/callback'` for non-Tauri environments.

---

## Scope

### In Scope

| Item | Description |
|------|-------------|
| Add npm dependency | `@fabianlars/tauri-plugin-oauth` (npm package) |
| Add Rust crate | `tauri-plugin-oauth` (Cargo.toml dependency) |
| Create `src/lib/oauth-loopback.ts` | New module implementing the loopback server flow |
| Delete `src/lib/oauth-webview.ts` | Remove the WebviewWindow-based implementation entirely |
| Update `src/hooks/use-oauth-connect.ts` | Replace `startOAuthFlowWebview` with `startOAuthFlowLoopback` on the desktop branch |
| Update `src/lib/oauth-redirect.ts` | Add loopback URI branch for desktop Tauri (`http://127.0.0.1:<port>`) |
| Update `src/integrations/google/auth.ts` | Accept optional `redirectUri` param to `getOAuthConfig`, `buildAuthUrl`, and `exchangeCodeForTokens` |
| Update `src/integrations/microsoft/auth.ts` | Same optional `redirectUri` param changes |
| Update `src/lib/auth.ts` | Propagate optional `redirectUri` through `buildAuthUrl` and `exchangeCodeForTokens` wrappers |
| Update Tauri capabilities | Add `oauth:default` permission; add localhost loopback URLs to `http:allow`; remove webview-creation permissions no longer needed |
| Register plugin in Rust | Add `tauri_plugin_oauth::init()` to `src-tauri/src/lib.rs` builder |
| Write unit tests | `src/lib/oauth-loopback.test.ts` covering happy path, state mismatch, port exhaustion, cleanup |
| Update existing tests | Update `use-oauth-connect.test.tsx` to replace `startOAuthFlowWebview` mock with `startOAuthFlowLoopback` mock |

### Out of Scope

| Item | Reason |
|------|--------|
| Mobile flow changes | Mobile uses `openUrl` + deep link, which works and is accepted by Google/Microsoft |
| Backend changes | The backend `POST /auth/google/exchange` endpoint already accepts `redirect_uri` in the request body; no server-side changes needed |
| Google Cloud Console configuration | The loopback ports `127.0.0.1:17421`, `127.0.0.1:17422`, `127.0.0.1:17423` must already be registered as authorized redirect URIs. This is a manual console action, not a code change. |
| Microsoft Entra (Azure AD) configuration | Same — the three loopback redirect URIs must be registered manually in the Azure app registration. |
| New UI components | The existing connecting/error state UI requires no visual changes |
| Retry logic changes | Existing `connectingTimeoutMs` (15 seconds) timeout behavior is unchanged |

---

## Technical Design

### New Dependency: `tauri-plugin-oauth`

The [`tauri-plugin-oauth`](https://github.com/FabianLars/tauri-plugin-oauth) plugin by Fabian Lars provides:

- A Rust-side HTTP server that binds to a loopback address and waits for a single GET request (the OAuth callback redirect)
- A JavaScript API: `start(options)` returns the allocated port, `cancel(port)` stops the server
- When the callback arrives, the plugin emits a Tauri event `oauth://url` carrying the full callback URL

**Installation:**

```bash
# npm
bun add @fabianlars/tauri-plugin-oauth@latest

# Cargo.toml
tauri-plugin-oauth = "2"
```

**Registration in `src-tauri/src/lib.rs`:**

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_oauth::init())
    // ...existing plugins
```

---

### `src/lib/oauth-loopback.ts` (new file)

```typescript
import { start, cancel } from '@fabianlars/tauri-plugin-oauth'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { OAuthProvider, OAuthTokens } from './auth'
import { buildAuthUrl, exchangeCodeForTokens, getUserInfo } from './auth'
import type { GoogleUserInfo } from './auth'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'
import { v4 as uuidv4 } from 'uuid'

/** Ports pre-registered in Google Cloud Console and Microsoft Entra as redirect URIs */
const loopbackPorts = [17421, 17422, 17423]

/**
 * Start OAuth flow using system browser + localhost loopback server.
 * Compliant with Google's requirement that OAuth not use embedded webviews.
 */
export const startOAuthFlowLoopback = async (
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo } | null> => {
  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const port = await start({ ports: loopbackPorts })
  const redirectUri = `http://127.0.0.1:${port}`

  let unlisten: (() => void) | null = null

  try {
    const result = await new Promise<{ code: string; state: string } | null>((resolve, reject) => {
      listen<string>('oauth://url', (event) => {
        const url = new URL(event.payload)
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        if (error) {
          reject(new Error(error))
          return
        }

        if (code && returnedState) {
          resolve({ code, state: returnedState })
          return
        }

        resolve(null)
      }).then((fn) => {
        unlisten = fn
      })

      const authUrl = buildAuthUrl(provider, state, codeChallenge, redirectUri)
      authUrl.then((url) => openUrl(url)).catch(reject)
    })

    if (!result) return null

    if (result.state !== state) {
      throw new Error('OAuth state mismatch')
    }

    const tokens = await exchangeCodeForTokens(provider, result.code, codeVerifier, redirectUri)
    const userInfo = await getUserInfo(provider, tokens.access_token)

    return { tokens, userInfo }
  } finally {
    unlisten?.()
    await cancel(port)
  }
}
```

**Key design choices:**

- `finally` block ensures `cancel(port)` is always called — no port leaks regardless of success, error, or cancellation.
- `unlisten?.()` stops the Tauri event listener before the function returns.
- The `redirectUri` is passed as an explicit parameter down through `buildAuthUrl` and `exchangeCodeForTokens` so the loopback URI is used consistently in both the authorization request and the token exchange.
- PKCE (`generateCodeVerifier`, `generateCodeChallenge`) from the existing `src/lib/pkce.ts` module is reused.
- `state` is validated before token exchange.

---

### Changes to `src/lib/auth.ts`

The `buildAuthUrl` and `exchangeCodeForTokens` wrappers gain an optional `redirectUri` parameter:

```typescript
export const buildAuthUrl = async (
  provider: OAuthProvider,
  state: string,
  codeChallenge: string,
  redirectUri?: string,  // NEW — optional override
): Promise<string> => {
  return providers[provider].buildAuthUrl(state, codeChallenge, redirectUri)
}

export const exchangeCodeForTokens = async (
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
  redirectUri?: string,  // NEW — optional override
): Promise<OAuthTokens> => {
  return providers[provider].exchangeCodeForTokens(code, codeVerifier, redirectUri)
}
```

When `redirectUri` is `undefined`, each provider's `getOAuthConfig()` falls back to the existing `getOAuthRedirectUri()` logic (unchanged for web and mobile).

---

### Changes to `src/integrations/google/auth.ts`

```typescript
export const buildAuthUrl = async (
  state: string,
  codeChallenge: string,
  redirectUri?: string,
): Promise<string> => {
  const config = await getOAuthConfig()
  const effectiveRedirectUri = redirectUri ?? config.redirectUri
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  // ... all existing params unchanged
  authUrl.searchParams.set('redirect_uri', effectiveRedirectUri)
  return authUrl.toString()
}

export const exchangeCodeForTokens = async (
  code: string,
  codeVerifier: string,
  redirectUri?: string,
): Promise<OAuthTokens> => {
  const config = await getOAuthConfig()
  const effectiveRedirectUri = redirectUri ?? config.redirectUri
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  return await ky
    .post(`${cloudUrl}/auth/google/exchange`, {
      json: { code, code_verifier: codeVerifier, redirect_uri: effectiveRedirectUri },
    })
    .json<OAuthTokens>()
}
```

Identical changes apply to `src/integrations/microsoft/auth.ts`.

---

### Changes to `src/hooks/use-oauth-connect.ts`

Replace the webview import and usage with the loopback equivalent:

```typescript
// Before:
import { startOAuthFlowWebview } from '@/lib/oauth-webview'

// After:
import { startOAuthFlowLoopback } from '@/lib/oauth-loopback'
```

```typescript
// Before (desktop branch):
} else {
  const result = await startFlow(provider)   // startFlow was startOAuthFlowWebview
  ...
}

// After:
} else {
  const result = await startFlow(provider)   // startFlow is now startOAuthFlowLoopback
  ...
}
```

The `OAuthDependencies` type is updated accordingly:

```typescript
// Before:
type OAuthDependencies = {
  startOAuthFlowWebview?: typeof startOAuthFlowWebview
  ...
}

// After:
type OAuthDependencies = {
  startOAuthFlowLoopback?: typeof startOAuthFlowLoopback
  ...
}
```

---

### Changes to `src/lib/oauth-redirect.ts`

The loopback `redirectUri` is determined at runtime (after the plugin allocates a port), so `getOAuthRedirectUri()` does **not** need to return a loopback URI. The loopback URI is passed explicitly by `oauth-loopback.ts`.

The only change needed: remove the desktop Tauri branch that returned `window.location.origin + '/oauth-callback.html'` since that path is no longer used:

```typescript
// Before:
export const getOAuthRedirectUri = (): string => {
  if (!isTauri()) {
    return window.location.origin + '/oauth/callback'
  }
  if (isMobile()) {
    return 'https://thunderbolt.io/oauth/callback'
  }
  return window.location.origin + '/oauth-callback.html'  // REMOVE
}

// After:
export const getOAuthRedirectUri = (): string => {
  if (!isTauri()) {
    return window.location.origin + '/oauth/callback'
  }
  // Mobile: App Link / Universal Link
  return 'https://thunderbolt.io/oauth/callback'
}
```

---

### Changes to Tauri capabilities

**`src-tauri/capabilities/default.json`** — add loopback localhost ports to the `http:allow` list, and add `oauth:default`:

```json
{
  "permissions": [
    "oauth:default",
    {
      "identifier": "http:default",
      "allow": [
        { "url": "http://127.0.0.1:17421" },
        { "url": "http://127.0.0.1:17422" },
        { "url": "http://127.0.0.1:17423" },
        ...existing entries
      ]
    },
    ...existing permissions
  ]
}
```

**`src-tauri/capabilities/auth.json`** — this file exists solely for the OAuth webview windows (`"windows": ["oauth-*"]`). Once `oauth-webview.ts` is deleted and no `WebviewWindow` is created for OAuth, this capability file can be **deleted**.

---

### File Deletions

| File | Reason |
|------|--------|
| `src/lib/oauth-webview.ts` | Replaced entirely by `src/lib/oauth-loopback.ts` |
| `src-tauri/capabilities/auth.json` | Only existed to grant permissions to the OAuth `WebviewWindow`; no longer needed |

---

## Security Requirements

### SR-001: PKCE must be used

PKCE (`code_challenge` / `code_verifier`) is already implemented in `src/lib/pkce.ts` and used by the existing flows. The loopback implementation reuses `generateCodeVerifier()` and `generateCodeChallenge()` from the same module. No change is required to the PKCE implementation.

**Verification:** `buildAuthUrl` sets `code_challenge` and `code_challenge_method: 'S256'`. `exchangeCodeForTokens` includes `code_verifier` in the token exchange request.

---

### SR-002: State parameter must be validated before token exchange

The `state` value generated at flow start must be compared to the `state` returned in the OAuth callback before `exchangeCodeForTokens` is called. A mismatch must throw an error and abort the flow.

**Verification:** `oauth-loopback.ts` validates `result.state !== state` and throws `'OAuth state mismatch'` if they differ. Token exchange is not reached on mismatch.

---

### SR-003: Loopback server must be cleaned up in a `finally` block

The loopback port must be released regardless of whether the OAuth flow succeeds, fails with an error, or is interrupted. A leaked open port could be exploited by a local attacker to intercept a future OAuth callback.

**Verification:** `oauth-loopback.ts` wraps the entire flow in `try { ... } finally { unlisten?.(); await cancel(port) }`. This guarantees cleanup under all exit conditions.

---

### SR-004: No credentials stored in code

Client secrets are not present in the frontend. Token exchange is proxied through the Thunderbolt backend (`POST /auth/google/exchange`, `POST /auth/microsoft/exchange`), which holds the client secret server-side. The frontend only handles the authorization code and PKCE verifier, both of which are short-lived.

---

### SR-005: Loopback redirect URIs must be pre-registered

Google and Microsoft only redirect to pre-registered URIs. The three ports (`17421`, `17422`, `17423`) must be registered in Google Cloud Console and Microsoft Entra **before** the feature ships. This is a manual operational step (out of scope for code), but its absence will cause failures identical to the current bug.

**Verification:** QA must confirm all three loopback URIs are registered before marking THU-302 as done.

---

### SR-006: Port allocation uses pre-registered list only

The plugin's `ports` option is set to `[17421, 17422, 17423]` — the exact set registered with Google/Microsoft. A random or OS-assigned port would not be in the registered list and Google would reject it. The implementation must never pass an empty `ports` array or allow arbitrary port selection.

---

## Test Plan

### Unit tests: `src/lib/oauth-loopback.test.ts`

| Test | Description |
|------|-------------|
| Happy path | Mock `start` returns port 17421, mock `listen` emits a valid callback URL, mock `openUrl` no-ops. Assert tokens and userInfo are returned. Assert `cancel(17421)` is called. |
| State mismatch | Callback URL contains `state` that does not match the generated value. Assert error `'OAuth state mismatch'` is thrown. Assert `cancel` is called. |
| OAuth error in callback | Callback URL contains `error=access_denied`. Assert error is thrown. Assert `cancel` is called. |
| Null result | `listen` emits URL with neither `code` nor `error`. Assert `null` is returned. Assert `cancel` is called. |
| Port exhaustion | Mock `start` throws. Assert the error propagates. Assert `cancel` is not called (port was never allocated). |
| Cleanup on exchange error | `exchangeCodeForTokens` throws. Assert `cancel` is still called (finally block). |

### Integration / manual tests

| Test | Description |
|------|-------------|
| Desktop Google connect | Click "Connect Google" on macOS/Windows/Linux build. Confirm system browser opens. Confirm app receives callback. Confirm email shown in integration tile. |
| Desktop Microsoft connect | Same flow for Microsoft. |
| Mobile Google connect unchanged | On iOS/Android build, confirm `openUrl` + deep link callback continues to work. |
| Web Google connect unchanged | On browser deployment, confirm redirect flow continues to work. |
| Port in use | Occupy port 17421 externally. Confirm plugin falls back to 17422. |
| Browser closed without consent | Close browser tab mid-flow. Confirm app times out at 15 seconds and clears connecting state. |

### Regression tests to run before merge

- `bun test src/lib/oauth-loopback.test.ts`
- `bun test src/hooks/use-oauth-connect.test.tsx`
- `bun test src/lib/oauth-redirect.test.ts`
- `bun test src/lib/pkce.test.ts`

---

## Migration Notes

### Breaking changes

- `src/lib/oauth-webview.ts` is deleted. Any import of `startOAuthFlowWebview` will fail at compile time. The only known consumer is `src/hooks/use-oauth-connect.ts`, which is updated as part of this work.
- `OAuthDependencies` type in `use-oauth-connect.ts` renames `startOAuthFlowWebview` to `startOAuthFlowLoopback`. Any test or caller constructing this type must update the property name.

### Non-breaking changes

- `buildAuthUrl` and `exchangeCodeForTokens` gain an optional `redirectUri?` parameter. Existing callers that pass no fourth argument continue to work with the existing `getOAuthRedirectUri()` fallback.

---

## Open Questions

1. **Timeout behavior:** The current `connectingTimeoutMs` is 15 seconds (session storage). For the loopback flow, the user must switch to the browser and sign in. Is 15 seconds sufficient, or should it be extended for the desktop loopback flow? Current recommendation: extend to 5 minutes for the desktop loopback branch only, matching a reasonable sign-in time.

2. **Browser does not open:** On some Linux desktops, `openUrl` may silently fail if no default browser is set. Should the app display the auth URL as a copyable link as a fallback? This is a polish concern and can be tracked separately.

3. **Port registration confirmation:** Who is responsible for registering the three loopback URIs in Google Cloud Console and Microsoft Entra? This must be confirmed before QA can run the integration tests.
