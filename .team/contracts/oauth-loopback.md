# Contract: `src/lib/oauth-loopback.ts`

**Issue:** THU-302
**Depends on:** `src/lib/auth.ts` (updated signatures), `@fabianlars/tauri-plugin-oauth`

---

## Module Purpose

Replaces `src/lib/oauth-webview.ts`. Implements the desktop OAuth flow using a localhost loopback server + system browser instead of an embedded WebviewWindow.

## Exported API

### `startOAuthFlowLoopback`

```typescript
/**
 * Starts an OAuth flow using a localhost loopback server and the system browser.
 * Opens the system browser to the OAuth provider's consent screen, waits for
 * the redirect callback on a localhost port, then exchanges the code for tokens.
 *
 * @returns Token + user info on success, null on timeout/cancellation
 * @throws On state mismatch, token exchange failure, or port binding failure
 */
export const startOAuthFlowLoopback = async (
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo } | null>
```

**Return type is intentionally identical to the old `startOAuthFlowWebview`** so the call site in `use-oauth-connect.ts` needs zero structural changes.

## Internal Constants

```typescript
/** Ports to try binding to. Must match Google/Microsoft Cloud Console redirect URI registrations. */
const loopbackPorts = [17421, 17422, 17423] as const

/** Timeout for the entire OAuth flow (user might abandon the browser tab). */
const oauthTimeoutMs = 5 * 60 * 1000

/** HTML shown in the browser after the redirect is captured. Must contain a <head> element. */
const completionHtml = `<html>
  <head><title>Thunderbolt</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="text-align: center; padding: 2rem;">
      <h2>Authentication Complete</h2>
      <p>You can close this tab and return to Thunderbolt.</p>
    </div>
  </body>
</html>`
```

## Internal Flow (Pseudocode)

```typescript
export const startOAuthFlowLoopback = async (provider) => {
  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  // 1. Start loopback server
  const port = await start({ ports: [...loopbackPorts], response: completionHtml })
  const redirectUri = `http://localhost:${port}`

  // 2. Register listener BEFORE opening browser
  let unlisten: (() => void) | undefined

  try {
    // 3. Create promise that resolves when callback URL arrives
    const callbackUrl = await Promise.race([
      new Promise<string>((resolve) => {
        const unlistenPromise = onUrl((url) => resolve(url))
        unlistenPromise.then((fn) => { unlisten = fn })
      }),
      // Wait for unlisten to be assigned before opening browser
      // (onUrl returns synchronously enough that this is safe --
      //  the listener is registered via Tauri event system before
      //  the browser can possibly redirect back)
    ])

    // Actually: restructure to avoid race --
    // register onUrl first, get unlisten, THEN open browser

    unlisten = await onUrl((url) => { /* resolve promise */ })

    const authUrl = await buildAuthUrl(provider, state, codeChallenge, redirectUri)
    await openUrl(authUrl)

    const callbackUrl = await Promise.race([urlPromise, timeoutPromise])

    // 4. Parse callback
    const url = new URL(callbackUrl)
    const code = url.searchParams.get('code')
    const returnedState = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) throw new Error(`OAuth error: ${error}`)
    if (!code || !returnedState) throw new Error('Missing code or state in OAuth callback')
    if (returnedState !== state) throw new Error('OAuth state mismatch')

    // 5. Exchange code for tokens
    const tokens = await exchangeCodeForTokens(provider, code, codeVerifier, redirectUri)
    const userInfo = await getUserInfo(provider, tokens.access_token)

    return { tokens, userInfo }
  } catch (error) {
    if (error instanceof Error && error.message === 'OAuth flow timed out') {
      return null
    }
    throw error
  } finally {
    // 6. ALWAYS clean up
    unlisten?.()
    await cancel(port).catch(() => {})
  }
}
```

## Refined Implementation Pattern

The key ordering concern is: `onUrl` listener must be registered BEFORE `openUrl` is called. The implementation uses this pattern:

```typescript
const { promise: urlPromise, resolve: resolveUrl } = Promise.withResolvers<string>()

const unlisten = await onUrl((url) => resolveUrl(url))

const authUrl = await buildAuthUrl(provider, state, codeChallenge, redirectUri)
await openUrl(authUrl)

const callbackUrl = await Promise.race([
  urlPromise,
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('OAuth flow timed out')), oauthTimeoutMs)
  ),
])
```

`Promise.withResolvers` (available in all modern engines, supported by Bun) avoids the executor callback pattern and makes the flow linear and readable.

## Dependencies

### Imports

```typescript
import { start, cancel, onUrl } from '@fabianlars/tauri-plugin-oauth'
import { openUrl } from '@tauri-apps/plugin-opener'
import { v4 as uuidv4 } from 'uuid'
import {
  type OAuthProvider,
  type OAuthTokens,
  type GoogleUserInfo,
  buildAuthUrl,
  exchangeCodeForTokens,
  getUserInfo,
} from './auth'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'
```

### Platform Guard

This module should NOT contain a `isTauri()` guard. It is only ever called from the desktop branch in `use-oauth-connect.ts`, which already guards on `isTauri() && !isMobile()`. Importing Tauri plugins at the top level is safe because the module is only imported when the desktop branch is taken (dynamic import is NOT needed since all Tauri plugin imports are already guarded at the hook level).

## Error Handling

| Scenario | Behavior |
|---|---|
| All ports occupied | `start()` throws; error propagates to `use-oauth-connect.ts` catch block |
| User closes browser without completing | 5-minute timeout; returns `null` |
| State mismatch | Throws `Error('OAuth state mismatch')` |
| Token exchange fails | Network error propagates |
| `cancel()` fails in finally | Silently caught (`.catch(() => {})`) -- server thread will exit anyway |

## Test Strategy

Unit tests for `oauth-loopback.ts` are impractical because the module depends on Tauri IPC (`start`, `cancel`, `onUrl`, `openUrl`). These are not available outside a Tauri runtime.

Testing approach:
- The `use-oauth-connect.ts` hook test uses dependency injection (the `dependencies` option) to mock `startOAuthFlowLoopback`, same as it currently mocks `startOAuthFlowWebview`
- Manual E2E testing on macOS, Windows, Linux is required for the loopback flow itself
- The URL parsing logic (extracting code, state, error from a URL string) can be extracted into a pure function and unit tested separately if desired
