# Client Auth and Session

Where the session credential lives, how it survives a reload or an offline boot, how tabs stay in
agreement, and which window events each failure mode fires.

Server side: [Authentication](../../../backend/docs/authentication.md),
[Architecture § Backend](README.md#backend). Device identity and the credentials-invalid matrix:
[PowerSync, Accounts and Devices](powersync-account-devices.md#7-frontend-credentials-invalid-and-reset).

## What is stored on the device

| Key                             | Written by                                                                    | Purpose                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `thunderbolt_auth_token`        | `setAuthToken` ([auth-token.ts:36](../../../src/lib/auth-token.ts))           | The bearer credential                                                                 |
| `thunderbolt_device_id`         | `getDeviceId` ([auth-token.ts:23](../../../src/lib/auth-token.ts))            | Lazily minted `crypto.randomUUID()`; sent as `X-Device-ID`                            |
| `thunderbolt_user_cache_secret` | `getUserCacheSecret` ([auth-token.ts:61](../../../src/lib/auth-token.ts))     | Tinfoil prompt-cache namespace; per-device, never synced, must reach only the enclave |
| `thunderbolt_session_cache`     | `setCachedSession` ([session-cache.ts:58](../../../src/lib/session-cache.ts)) | Last good `/get-session` payload, for offline boot                                    |

No production path calls `localStorage.clear()`. The one teardown is `clearLocalData`
([cleanup.ts:33](../../../src/lib/cleanup.ts)), which removes those keys last together with the ACP bridge's
plaintext `iroh_acp_client_secret`
([iroh-transport.ts:87](../../../src/acp/iroh/iroh-transport.ts)).

### Why a bearer token, in plaintext storage

- **Every platform authenticates with `Authorization: Bearer <token>`, including the browser**: the backend
  enables `bearer({ requireSignature: true })`
  ([auth.ts:326](../../../backend/src/auth/auth.ts)). The stored value is the _signed_ token
  `rawSessionToken.base64Signature`, the same value Better Auth puts in the session cookie, verified by
  HMAC-SHA256 over the raw token ([bearer-token.ts:11](../../../backend/src/auth/bearer-token.ts)).
- **`localStorage`, not the encrypted settings database, because the getter is synchronous**:
  `token: () => getAuthToken() ?? ''`
  ([auth-context.tsx:148-151](../../../src/contexts/auth-context.tsx)), and `localStorage` is the only
  storage the app has that answers synchronously. A TODO at
  [auth-token.ts:5-12](../../../src/lib/auth-token.ts) moves it once an encryption middleware can serve it.
- **The plaintext tradeoff is argued once**, at `getUserCacheSecret`
  ([auth-token.ts:50-60](../../../src/lib/auth-token.ts)).

### How the token gets there

The backend returns it in a `set-auth-token` response header
([auth.ts:51](../../../backend/src/auth/auth.ts)) and the auth client's `onSuccess` fetch hook captures it
([auth-context.tsx:152-157](../../../src/contexts/auth-context.tsx)). It reaches browser JavaScript only
because `corsExposeHeaders` lists it ([settings.ts:11](../../../backend/src/config/settings.ts)); dropping it
there silently breaks every web sign-in.

## Auth modes

Build-time flags read through [src/lib/auth-mode.ts](../../../src/lib/auth-mode.ts) and baked in by Vite.
Operator view: [Self-hosting § Configuration](../../self-hosting/configuration.md).

| Flag                         | Effect                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_AUTH_MODE=sso`         | Enterprise SSO. Auth requests switch to `credentials: 'include'`; unauthenticated users go to `/sso-redirect`                   |
| `VITE_AUTH_ENABLE_ANONYMOUS` | Anonymous-session overlay. Needs the backend's `AUTH_ALLOW_ANONYMOUS` too, or the UI offers a route the server answers with 404 |
| `VITE_BYPASS_WAITLIST`       | Skips the client-side waitlist redirect. UI only; the backend still gates sign-in                                               |

Consumer mode runs `credentials: 'omit'`
([auth-context.tsx:134](../../../src/contexts/auth-context.tsx)): the bearer token is the whole credential, so
cookies would add ambient authority for nothing. The PowerSync connector repeats the SSO-only choice when
fetching a sync JWT ([connector.ts:104-105](../../../src/db/powersync/connector.ts)).

### Which routes a session may reach

`useAuthGate` ([use-auth-gate.ts:35](../../../src/components/auth-gate/use-auth-gate.ts)) turns session state
plus those flags into `loading` / `allowed` / `redirect`; `AuthGate` renders `<Navigate replace />` rather
than navigating from an effect.

- **Anonymous users count as authenticated for routing**, with a real `user` row carrying
  `isAnonymous: true`. Capability gating belongs to the route.
- **Anonymous auto-sign-in needs all three of** `isAnonymousAuthEnabled()`, `!isSsoMode()` and
  `isWaitlistBypassed()` ([use-auth-gate.ts:40](../../../src/components/auth-gate/use-auth-gate.ts)); a ref
  dedups Strict Mode's double effect.
- **Both failure shapes are handled** ([use-auth-gate.ts:48-73](../../../src/components/auth-gate/use-auth-gate.ts)).
  Better Auth methods resolve with `{ data, error }` rather than throwing on a 4xx, so a hook ignoring the
  resolved-error path leaves the gate in `loading` forever.

## Booting with a session

`AuthProvider` builds the auth client from `cloudUrl` in a `useMemo`, so a backend URL change replaces the
client wholesale ([auth-context.tsx:206-216](../../../src/contexts/auth-context.tsx)). Session plumbing, in
order:

1. **Seed the session atom from the cache, synchronously.** `hydrateSessionFromCache`
   ([auth-context.tsx:70](../../../src/contexts/auth-context.tsx)) writes the cached payload into
   `client.$store.atoms.session` at construction, and no-ops without a stored token. Otherwise an offline
   boot fails `/get-session` and the gate sends a signed-in user to `/waitlist` (THU-580). `useAuthQuery`
   keeps non-null `data` across non-401 errors, so the seed survives until the first successful refetch.
2. **Discard an expired cache instead of seeding it.** `isCachedSessionValid`
   ([session-cache.ts:79](../../../src/lib/session-cache.ts)) requires a parseable `session.expiresAt` in the
   future; past its TTL every call 401s anyway.
3. **Mirror later payloads back to the cache.** `subscribeSessionCachePersist`
   ([auth-context.tsx:106](../../../src/contexts/auth-context.tsx)) writes every payload having both `user`
   and `session`, returning the nanostores unsubscribe from an effect keyed on the memo (otherwise a
   `cloudUrl` change leaks the old client and its refresh manager). Two filters:
   `{ user: null, session: null }` can transit the atom on the initial `onSuccess` and must not be cached
   (a logged-out flash next boot); a real sign-out (`null`) is a deliberate no-op, since the 401 handler
   and `clearLocalData` own cache clearing.
4. **Validate the stored token once, on mount**, through `HttpClient` rather than the auth client, so the
   check sidesteps Better Auth's retry path and lands on the `afterResponse` 401 hook
   ([auth-context.tsx:246-259](../../../src/contexts/auth-context.tsx)).

`refetchOnWindowFocus` and `refetchWhenOffline` are both `false`
([auth-context.tsx:36-43](../../../src/contexts/auth-context.tsx)): the `storage` listener covers cross-tab
changes and the 401 handling covers expiry, so leaving them on only spends rate-limit budget on every
focus, `visibilitychange` and `online`.

## Cross-tab agreement

`AuthProvider` subscribes at [auth-context.tsx:267-281](../../../src/contexts/auth-context.tsx):

| Change                                | Response                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token replaced with a different token | Clear the cached session, then reload. A rotation may be an identity change, and the reloaded tab would otherwise seed the previous user's profile under the new token |
| Token cleared                         | Another tab signed out. Dispatch the same `powersync_credentials_invalid` / `session_expired` event the 401 path uses                                                  |

`onAuthTokenChangedInOtherTab` ([auth-token.ts:107](../../../src/lib/auth-token.ts)) wraps the window
`storage` event, which by specification fires only in tabs _other_ than the writer; hence the token is not
merely held in memory. It filters to `localStorage` and the token key, ignoring same-value writes.

## Event contracts

| Event                           | Declared in                                                                  | Dispatched by                                                                                                                            | Consumed by                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `powersync_credentials_invalid` | [connector.ts:21](../../../src/db/powersync/connector.ts)                    | Connector token refresh, `HttpClient.afterResponse` ([http.ts:240](../../../src/lib/http.ts)), Better Auth `onError`, cross-tab listener | [use-powersync-credentials-invalid-listener.ts:67](../../../src/hooks/use-powersync-credentials-invalid-listener.ts)                                                         |
| `show_sign_in_modal`            | [use-credential-events.ts:11](../../../src/hooks/use-credential-events.ts)   | The listener above, on `session_expired`                                                                                                 | [SignInModalProvider](../../../src/contexts/sign-in-modal-context.tsx)                                                                                                       |
| `sign_in_success`               | [use-credential-events.ts:14](../../../src/hooks/use-credential-events.ts)   | `SignInModalProvider` after a successful re-auth                                                                                         | The credentials-invalid listener, to reset its dedup ref                                                                                                                     |
| `show_revoked_device_modal`     | [use-credential-events.ts:8](../../../src/hooks/use-credential-events.ts)    | The credentials-invalid listener                                                                                                         | [useCredentialEvents](../../../src/hooks/use-credential-events.ts) in `App`                                                                                                  |
| `app_version_unsupported`       | [app-version-unsupported.ts:13](../../../src/lib/app-version-unsupported.ts) | `handleAppVersionUnsupported` on a 426 (or an `APP_VERSION_UNSUPPORTED` body code) from our backend                                      | [useAppVersionUnsupportedListener](../../../src/hooks/use-app-version-unsupported-listener.ts) and the sync layer ([database.ts:227](../../../src/db/powersync/database.ts)) |

Window `CustomEvent`s rather than imports: the producers sit below the React tree, and importing the
consumer would close import cycles (HTTP client → PowerSync connector → sync tracker → PostHog → HTTP
client). The cost is one contract duplicated per event, each copy carrying a comment saying so.

### Load-bearing properties of the 401 path

- **Only a 401 against an _existing_ token is an expiry.** Better Auth's `onError` captures token presence
  before clearing it, so a 401 from sign-in or OTP-verify does not pop the sign-in modal
  ([auth-context.tsx:169-179](../../../src/contexts/auth-context.tsx)).
- **Only _our_ backend's 401s count.** `HttpClient` also serves external APIs with caller-supplied OAuth
  tokens, so `beforeRequest` and `afterResponse` both gate on `isBackendRequest`
  ([http.ts:95-103](../../../src/lib/http.ts)) before setting headers or reading a status as a session
  signal.
- **The bearer token is the exception to that gate**, set on any request not already carrying an
  `Authorization` header; a caller hitting a third-party API must supply its own
  ([http.ts:201-206](../../../src/lib/http.ts)).
- **`session_expired` yields to a revocation or a deletion**, via the listener's refs, rather than stacking
  a sign-in modal on a teardown
  ([use-powersync-credentials-invalid-listener.ts:93-106](../../../src/hooks/use-powersync-credentials-invalid-listener.ts)).
  Expiry clears the token and stops sync but keeps the database, the encryption keys and the device id.

### The 426 latch

`app_version_unsupported` mirrors that pattern for the version gate
([AGENTS.md § App version gate](../../../AGENTS.md#app-version-gate)). `handleAppVersionUnsupported`
([app-version-unsupported.ts:46-52](../../../src/lib/app-version-unsupported.ts)) latches a module-level flag
**before** dispatching, so a caller reading the latch rather than the event still sees the block.
`isAppVersionUnsupported()` ([app-version.ts:49](../../../src/lib/app-version.ts)) ORs it with the persisted
`/config` minimum, and every sync entry point consults it
([database.ts:250](../../../src/db/powersync/database.ts)). Otherwise a version-blocked client holding a sync
stream queues writes in `ps_crud` and flushes them after the upgrade, before the E2EE keyring exists
([database.ts:207-218](../../../src/db/powersync/database.ts)).

## The header contract

Every backend request carries the bearer token, device identity, `X-App-Version` and `X-App-Language`.
Three builders produce that set and must stay in step:

| Path                                                 | Builder                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Anything holding an `HttpClient`                     | `beforeRequest` hook ([http.ts:199-223](../../../src/lib/http.ts))                      |
| Callers that cannot, notably the PowerSync connector | `getAuthenticatedHeaders()` ([auth-token.ts:83](../../../src/lib/auth-token.ts))        |
| Better Auth methods                                  | `authRequestHeaders()` ([auth-context.tsx:123](../../../src/contexts/auth-context.tsx)) |

better-fetch **replaces** rather than merges the headers object, so a Better Auth call passing
`fetchOptions.headers` drops the client-level set and 426s on a current build. `authRequestHeaders()` is
applied through `onRequest` to survive that shallow spread, and re-read per request so the locale is not
frozen at client construction. Rules: [AGENTS.md § App version gate](../../../AGENTS.md#app-version-gate) and
[§ The `X-App-Language` header](../../../AGENTS.md#the-x-app-language-header).

## Signing out

`LogoutModal` ([logout-modal.tsx:42-62](../../../src/components/logout-modal.tsx)) calls
`authClient.signOut()`, then `clearLocalData({ clearDatabase })` with the user's keep-or-delete choice,
then replaces the location (`/signed-out` in SSO mode, a plain reload otherwise). Both steps log and
continue on failure, since a sign-out that cannot reach the server must still clear the device.

## Where the code lives

| File                                                                                                                        | Role                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [src/lib/auth-token.ts](../../../src/lib/auth-token.ts)                                                                     | localStorage credentials, header builder, cross-tab subscription |
| [src/lib/session-cache.ts](../../../src/lib/session-cache.ts)                                                               | Offline session cache and its validity rule                      |
| [src/lib/auth-mode.ts](../../../src/lib/auth-mode.ts)                                                                       | The three build-time mode flags                                  |
| [src/contexts/auth-context.tsx](../../../src/contexts/auth-context.tsx)                                                     | Better Auth client construction, fetch hooks, provider effects   |
| [src/contexts/sign-in-modal-context.tsx](../../../src/contexts/sign-in-modal-context.tsx)                                   | Re-auth modal, dismissal routing, post-sign-in sync enablement   |
| [src/components/auth-gate/use-auth-gate.ts](../../../src/components/auth-gate/use-auth-gate.ts)                             | Route access decision                                            |
| [src/lib/http.ts](../../../src/lib/http.ts)                                                                                 | Authenticated client, header injection, 401/426 hooks            |
| [src/lib/app-version-unsupported.ts](../../../src/lib/app-version-unsupported.ts)                                           | 426 latch and event                                              |
| [src/hooks/use-powersync-credentials-invalid-listener.ts](../../../src/hooks/use-powersync-credentials-invalid-listener.ts) | Single consumer of the credentials-invalid event                 |
| [src/lib/cleanup.ts](../../../src/lib/cleanup.ts)                                                                           | The one teardown path                                            |

Tests: `src/lib/auth-token.test.ts`, `src/lib/session-cache.test.ts`,
`src/contexts/auth-context.test.ts`, `src/components/auth-gate/use-auth-gate.test.ts`.
