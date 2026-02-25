# Contract: Auth Function Signature Changes

**Issue:** THU-302
**Affects:** `src/integrations/google/auth.ts`, `src/integrations/microsoft/auth.ts`, `src/lib/auth.ts`

---

## Motivation

The loopback OAuth flow constructs a dynamic `redirectUri` (`http://localhost:{port}`) that differs from the static URI returned by `getOAuthRedirectUri()`. The `buildAuthUrl` and `exchangeCodeForTokens` functions must accept an optional `redirectUri` override so the loopback flow can pass its dynamic URI while existing flows (web, mobile) continue to use the static default.

## `src/integrations/google/auth.ts`

### `buildAuthUrl`

```diff
- export const buildAuthUrl = async (state: string, codeChallenge: string): Promise<string> => {
+ export const buildAuthUrl = async (state: string, codeChallenge: string, redirectUri?: string): Promise<string> => {
    const config = await getOAuthConfig()
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', config.clientId)
-   authUrl.searchParams.set('redirect_uri', config.redirectUri)
+   authUrl.searchParams.set('redirect_uri', redirectUri ?? config.redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    // ... rest unchanged
```

### `exchangeCodeForTokens`

```diff
- export const exchangeCodeForTokens = async (code: string, codeVerifier: string): Promise<OAuthTokens> => {
+ export const exchangeCodeForTokens = async (code: string, codeVerifier: string, redirectUri?: string): Promise<OAuthTokens> => {
    const config = await getOAuthConfig()
    const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
    return await ky
      .post(`${cloudUrl}/auth/google/exchange`, {
-       json: { code, code_verifier: codeVerifier, redirect_uri: config.redirectUri },
+       json: { code, code_verifier: codeVerifier, redirect_uri: redirectUri ?? config.redirectUri },
      })
      .json<OAuthTokens>()
  }
```

### Functions NOT Changed

- `getOAuthConfig()` -- unchanged; still returns the static redirectUri for web/mobile
- `getUserInfo(accessToken)` -- unchanged; does not involve redirect URIs
- `refreshAccessToken(refreshToken)` -- unchanged; does not involve redirect URIs

## `src/integrations/microsoft/auth.ts`

Identical pattern to Google:

### `buildAuthUrl`

```diff
- export const buildAuthUrl = async (state: string, codeChallenge: string): Promise<string> => {
+ export const buildAuthUrl = async (state: string, codeChallenge: string, redirectUri?: string): Promise<string> => {
    const config = await getOAuthConfig()
    const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    authUrl.searchParams.set('client_id', config.clientId)
-   authUrl.searchParams.set('redirect_uri', config.redirectUri)
+   authUrl.searchParams.set('redirect_uri', redirectUri ?? config.redirectUri)
    // ... rest unchanged
```

### `exchangeCodeForTokens`

```diff
- export const exchangeCodeForTokens = async (code: string, codeVerifier: string): Promise<OAuthTokens> => {
+ export const exchangeCodeForTokens = async (code: string, codeVerifier: string, redirectUri?: string): Promise<OAuthTokens> => {
    const config = await getOAuthConfig()
    const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
    return await ky
      .post(`${cloudUrl}/auth/microsoft/exchange`, {
-       json: { code, code_verifier: codeVerifier, redirect_uri: config.redirectUri },
+       json: { code, code_verifier: codeVerifier, redirect_uri: redirectUri ?? config.redirectUri },
      })
      .json<OAuthTokens>()
  }
```

## `src/lib/auth.ts` (Provider-Agnostic Wrappers)

### `buildAuthUrl`

```diff
- export const buildAuthUrl = async (provider: OAuthProvider, state: string, codeChallenge: string): Promise<string> => {
-   return providers[provider].buildAuthUrl(state, codeChallenge)
+ export const buildAuthUrl = async (provider: OAuthProvider, state: string, codeChallenge: string, redirectUri?: string): Promise<string> => {
+   return providers[provider].buildAuthUrl(state, codeChallenge, redirectUri)
  }
```

### `exchangeCodeForTokens`

```diff
- export const exchangeCodeForTokens = async (
-   provider: OAuthProvider,
-   code: string,
-   codeVerifier: string,
- ): Promise<OAuthTokens> => {
-   return providers[provider].exchangeCodeForTokens(code, codeVerifier)
+ export const exchangeCodeForTokens = async (
+   provider: OAuthProvider,
+   code: string,
+   codeVerifier: string,
+   redirectUri?: string,
+ ): Promise<OAuthTokens> => {
+   return providers[provider].exchangeCodeForTokens(code, codeVerifier, redirectUri)
  }
```

### `providers` Type Constraint

The `providers` object is typed as:

```typescript
const providers = {
  google,
  microsoft,
} as const satisfies Record<OAuthProvider, typeof google>
```

This `satisfies` constraint ensures both providers expose the same function signatures. Since both `google.buildAuthUrl` and `microsoft.buildAuthUrl` will have the added optional `redirectUri` param, the constraint continues to hold. The `typeof google` inference picks up the new signature automatically.

## Backward Compatibility

All existing call sites pass NO `redirectUri` argument:

| Call site | Current call | After change |
|---|---|---|
| `src/lib/auth.ts` `startOAuthFlow` (line 92) | `buildAuthUrl(provider, state, codeChallenge)` | No change needed -- `redirectUri` defaults to `undefined` |
| `src/lib/auth.ts` `redirectOAuthFlow` (line 155) | `buildAuthUrl(provider, state, codeChallenge)` | No change needed |
| `src/hooks/use-oauth-connect.ts` mobile branch (line 200) | `buildAuthUrl(provider, state, codeChallenge)` | No change needed |
| `src/lib/auth.ts` `startOAuthFlow` (line 140) | `exchangeCodeForTokens(provider, code, oauthState.verifier)` | No change needed |
| `src/hooks/use-oauth-connect.ts` `processCallback` (line 290) | `exchangeTokens(provider, code, codeVerifier)` | No change needed |

The only call site that WILL pass `redirectUri` is the new `src/lib/oauth-loopback.ts`:
```typescript
const tokens = await exchangeCodeForTokens(provider, code, codeVerifier, redirectUri)
```

## Backend Consideration

The backend token exchange endpoints (`/auth/google/exchange`, `/auth/microsoft/exchange`) already accept `redirect_uri` in the request body. They use it to validate the token exchange against what was used in the authorization request. This is standard OAuth 2.0 -- the `redirect_uri` in the token exchange must exactly match what was sent in the authorization request.

No backend changes are needed. The backend already handles any valid `redirect_uri` value; it does not hardcode which URIs are accepted (that is the OAuth provider's job via the Cloud Console configuration).
