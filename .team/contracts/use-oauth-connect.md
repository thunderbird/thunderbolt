# Contract: `src/hooks/use-oauth-connect.ts` Changes

**Issue:** THU-302
**Depends on:** `src/lib/oauth-loopback.ts`

---

## Summary of Changes

This is a minimal, surgical replacement. The hook's structure, state management, and all three branches (mobile Tauri, desktop Tauri, web) remain identical. Only the desktop Tauri branch swaps the function it calls.

## Import Changes

```diff
- import { startOAuthFlowWebview } from '@/lib/oauth-webview'
+ import { startOAuthFlowLoopback } from '@/lib/oauth-loopback'
```

## Type Changes

### `OAuthDependencies`

```diff
  type OAuthDependencies = {
-   startOAuthFlowWebview?: typeof startOAuthFlowWebview
+   startOAuthFlowLoopback?: typeof startOAuthFlowLoopback
    redirectOAuthFlow?: typeof redirectOAuthFlow
    exchangeCodeForTokens?: typeof exchangeCodeForTokens
    getUserInfo?: typeof getUserInfo
  }
```

### `UseOAuthConnectResult`

No changes.

### `OAuthCallbackData`

No changes.

## Hook Body Changes

### Destructuring

```diff
  const {
-   startOAuthFlowWebview: startFlow = startOAuthFlowWebview,
+   startOAuthFlowLoopback: startLoopback = startOAuthFlowLoopback,
    redirectOAuthFlow: redirect = redirectOAuthFlow,
    exchangeCodeForTokens: exchangeTokens = exchangeCodeForTokens,
    getUserInfo: getUser = getUserInfo,
  } = dependencies || {}
```

### Desktop Branch (inside `connect`, lines 206-221)

```diff
        } else {
-         // For desktop: Use webview flow
-         const result = await startFlow(provider)
+         // For desktop: Use loopback flow (system browser + localhost server)
+         const result = await startLoopback(provider)

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

## Branches NOT Changed

### Mobile Branch (lines 185-205)

The mobile branch (`isMobile()`) continues to use `openUrl(authUrl)` with App Links / Universal Links. No change.

### Web Branch (lines 222-226)

The web branch continues to use `redirect(provider)`. No change.

### `processCallback` Function (lines 244-313)

No change. The `processCallback` is only used for web redirect flows and mobile deep link flows. The desktop loopback flow handles token exchange internally within `startOAuthFlowLoopback`.

## Test File Changes: `use-oauth-connect.test.tsx`

### Mock Dependencies

```diff
  const createMockDependencies = (): OAuthDependencies => ({
-   startOAuthFlowWebview: async () => {
+   startOAuthFlowLoopback: async () => {
      return null
    },
    redirectOAuthFlow: async (provider: string) => { ... },
    exchangeCodeForTokens: async () => ({ ... }),
    getUserInfo: async () => ({ ... }),
  })
```

All test logic remains unchanged. The mock function has the same signature and return type.

## Behavioral Contract

| Scenario | Before (webview) | After (loopback) |
|---|---|---|
| Desktop connect, success | WebviewWindow opens; user completes OAuth; tokens returned | System browser opens; localhost server captures redirect; tokens returned |
| Desktop connect, user cancels | User closes WebviewWindow; returns null | User abandons browser; 5-min timeout; returns null |
| Desktop connect, error | WebviewWindow captures error; throws | System browser redirects with error; throws |
| Mobile connect | Opens system browser via openUrl | Opens system browser via openUrl (UNCHANGED) |
| Web connect | Redirects via window.location.assign | Redirects via window.location.assign (UNCHANGED) |

The return type contract `Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo } | null>` is preserved exactly, so all downstream consumers (primarily `saveOAuthCredentials`) work without modification.
