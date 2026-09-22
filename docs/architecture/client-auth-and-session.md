# Client Auth and Session

How the app holds a session on the device: where the credentials live, how the session survives a reload
or an offline boot, how tabs stay in agreement, and which window events each failure mode fires.

The server side of authentication — Better Auth plugins, the OTP challenge token, OIDC/SAML — is
in [Authentication](../../backend/docs/authentication.md) and summarised in
[Architecture § Backend](./README.md#backend). Device identity and the full
credentials-invalid matrix live in
[PowerSync, Accounts and Devices](./powersync-account-devices.md#7-frontend-credentials-invalid-and-reset).
This page is about the client.

## The credential is a bearer token, and it lives in localStorage

Every platform authenticates with `Authorization: Bearer <token>`, including the browser. The backend
enables Better Auth's bearer plugin with `bearer({ requireSignature: true })`
([backend/src/auth/auth.ts:326](../../backend/src/auth/auth.ts)), so the credential the client stores is
the _signed_ session token — `rawSessionToken.base64Signature`, the same value Better Auth puts in the
session cookie, verified with an HMAC-SHA256 over the raw token
([backend/src/auth/bearer-token.ts:11](../../backend/src/auth/bearer-token.ts)).

The token is in `localStorage` rather than in the encrypted settings database for one reason: Better Auth
resolves the bearer token through a **synchronous** getter — `token: () => getAuthToken() ?? ''`
([src/contexts/auth-context.tsx:148-151](../../src/contexts/auth-context.tsx)) — and `localStorage` is the
only storage the app has that can answer synchronously
([src/lib/auth-token.ts:5-12](../../src/lib/auth-token.ts)). The same file carries a standing TODO to move
the token into the settings database once an encryption middleware can serve it. What follows from storing
a full-access credential in plaintext origin storage is argued once, at the next value that had to join it
— see the reasoning on `getUserCacheSecret` at
[src/lib/auth-token.ts:50-60](../../src/lib/auth-token.ts).

Four keys carry the session layer's state:

| Key                             | Written by                                                                 | Purpose                                                                               |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `thunderbolt_auth_token`        | `setAuthToken` ([auth-token.ts:36](../../src/lib/auth-token.ts))           | The bearer credential                                                                 |
| `thunderbolt_device_id`         | `getDeviceId` ([auth-token.ts:23](../../src/lib/auth-token.ts))            | Lazily minted `crypto.randomUUID()`; sent as `X-Device-ID`                            |
| `thunderbolt_user_cache_secret` | `getUserCacheSecret` ([auth-token.ts:61](../../src/lib/auth-token.ts))     | Tinfoil prompt-cache namespace; per-device, never synced, must reach only the enclave |
| `thunderbolt_session_cache`     | `setCachedSession` ([session-cache.ts:58](../../src/lib/session-cache.ts)) | Last good `/get-session` payload, for offline boot                                    |

No production path calls `localStorage.clear()`. Teardown goes through `clearLocalData`
([src/lib/cleanup.ts:33](../../src/lib/cleanup.ts)), which removes those keys as its last step — together
with the ACP bridge's `iroh_acp_client_secret`, another plaintext credential on the same teardown
([src/acp/iroh/iroh-transport.ts:87](../../src/acp/iroh/iroh-transport.ts)) — and is described in full in
the [devices doc](./powersync-account-devices.md#7-frontend-credentials-invalid-and-reset).

### How the token gets there

The backend returns the signed session token in a `set-auth-token` response header
([backend/src/auth/auth.ts:51](../../backend/src/auth/auth.ts)). The client captures it in the `onSuccess`
fetch hook it installs on the auth client
([src/contexts/auth-context.tsx:152-157](../../src/contexts/auth-context.tsx)). That header only reaches
browser JavaScript because the backend lists it in `corsExposeHeaders`
([backend/src/config/settings.ts:11](../../backend/src/config/settings.ts)) — a cross-origin response
exposes no custom header otherwise, so dropping it there silently breaks every sign-in on the web build.

## Auth modes

Three build-time flags shape which path a deployment offers. All three are read through
[src/lib/auth-mode.ts](../../src/lib/auth-mode.ts) and baked into the bundle by Vite; their operator-facing
description is in [Self-hosting § Configuration](../self-hosting/configuration.md).

| Flag                         | Effect                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_AUTH_MODE=sso`         | Enterprise SSO. Auth requests switch to `credentials: 'include'` and unauthenticated users are sent to `/sso-redirect`          |
| `VITE_AUTH_ENABLE_ANONYMOUS` | Anonymous-session overlay. Needs the backend's `AUTH_ALLOW_ANONYMOUS` too, or the UI offers a route the server answers with 404 |
| `VITE_BYPASS_WAITLIST`       | Skips the client-side waitlist redirect. A UI bypass only — the backend still gates sign-in                                     |

Consumer mode runs `credentials: 'omit'`: the bearer token is the whole credential, so sending cookies
would add an ambient-authority surface for nothing
([src/contexts/auth-context.tsx:134](../../src/contexts/auth-context.tsx)). SSO mode is the exception, and
the PowerSync connector makes the same SSO-only choice when it fetches a sync JWT — `getAuthenticatedHeaders()`
plus `credentials: 'include'` in SSO mode
([src/db/powersync/connector.ts:104-105](../../src/db/powersync/connector.ts)).

`useAuthGate` ([src/components/auth-gate/use-auth-gate.ts:35](../../src/components/auth-gate/use-auth-gate.ts))
turns the session state plus those flags into `loading` / `allowed` / `redirect`, and `AuthGate` renders
`<Navigate replace />` rather than navigating from an effect. Anonymous users count as authenticated for
routing — their session carries a real `user` row with `isAnonymous: true`, and per-route capability
gating belongs to the route, not the gate. Anonymous auto-sign-in only fires when all three of
`isAnonymousAuthEnabled()`, `!isSsoMode()` and `isWaitlistBypassed()` hold
([use-auth-gate.ts:40](../../src/components/auth-gate/use-auth-gate.ts)); a ref dedups it against Strict
Mode's double effect, and because Better Auth client methods resolve with `{ data, error }` instead of
throwing on a 4xx, the hook has to surface both the resolved-error and the thrown-network paths or the
gate stays in `loading` forever ([use-auth-gate.ts:48-73](../../src/components/auth-gate/use-auth-gate.ts)).

## Booting with a session

`AuthProvider` builds the auth client from `cloudUrl` inside a `useMemo`, so changing the backend URL
replaces the client wholesale ([src/contexts/auth-context.tsx:206-216](../../src/contexts/auth-context.tsx)).
The rest of the session plumbing hangs off that client, in this order.

**The session atom is seeded from the cache, synchronously.** `hydrateSessionFromCache`
([auth-context.tsx:70](../../src/contexts/auth-context.tsx)) writes the cached payload straight into
`client.$store.atoms.session` at construction time, and no-ops when no token is stored — a cache without a
credential is not a session. Without the seed, a device that boots offline fails its
initial `/get-session`, `data` stays null, and the gate reads that as logged-out and redirects a
previously-signed-in user to `/waitlist` (THU-580). Better Auth's `useAuthQuery` preserves non-null `data`
across non-401 errors, so the seed survives the failing offline fetch and is replaced by the first
successful refetch.

**An expired cache is discarded, not seeded.** `isCachedSessionValid`
([src/lib/session-cache.ts:79](../../src/lib/session-cache.ts)) requires a parseable `session.expiresAt` in
the future; a cache without one is treated as invalid. A device offline past its TTL would 401 on every
call anyway, and flashing a logged-in UI that is torn down a moment later is worse than a fresh
`/get-session`.

**Future session payloads are mirrored back.** `subscribeSessionCachePersist`
([auth-context.tsx:106](../../src/contexts/auth-context.tsx)) subscribes to the same atom and writes every
payload that has both `user` and `session`. It returns the nanostores unsubscribe and is called from an
effect keyed on the memo, because a `cloudUrl` change would otherwise leak the old client and its refresh
manager forever. Two filters matter: `{ user: null, session: null }` can transit the atom on the initial
query's `onSuccess` and must not be cached (it would resurrect as a logged-out flash next boot), and a
real sign-out (`null`) is deliberately a no-op here — clearing the cache belongs to the 401 handler and to
`clearLocalData`.

**The stored token is validated once on mount** — through `HttpClient`, not the auth client, so the check
sidesteps Better Auth's internal retry path and lands directly on the `afterResponse` 401 hook
([auth-context.tsx:246-259](../../src/contexts/auth-context.tsx)).

### Better Auth's own refetching is off

`refetchOnWindowFocus` and `refetchWhenOffline` are both set to `false`
([auth-context.tsx:36-43](../../src/contexts/auth-context.tsx)). The scenarios they exist for are already
covered — cross-tab changes by the `storage` listener below, expiry by the 401 handling in both fetch
layers — and leaving them on spends rate-limit budget on every focus, `visibilitychange` and `online`
event. Turning either back on needs a reason that those two mechanisms do not already serve.

## Cross-tab agreement

`onAuthTokenChangedInOtherTab` ([src/lib/auth-token.ts:107](../../src/lib/auth-token.ts)) wraps the window
`storage` event, which by specification fires only in tabs _other_ than the one that wrote the value —
that is exactly the cross-tab primitive wanted, and it is why the token is not merely kept in memory.
The listener filters to `localStorage` and the token key and ignores same-value writes; everything else is
handed to the subscriber, including the "other tab signed out" case.

`AuthProvider` subscribes at [auth-context.tsx:267-281](../../src/contexts/auth-context.tsx) and treats the
two directions differently:

- **Token replaced with a different token** — a rotation may also be an identity change, so the cached
  session is cleared first (otherwise the reloaded tab seeds the previous user's profile under the new
  token) and the page reloads.
- **Token cleared** — another tab signed out. It dispatches the same `powersync_credentials_invalid` /
  `session_expired` event the 401 path uses, so one flow handles both.

## Event contracts

The client signals auth failures as window `CustomEvent`s rather than through imports, because the
producers sit below the React tree and importing the consumer would close import cycles (the HTTP client
would pull in the PowerSync connector, which pulls in the sync tracker, which pulls in PostHog, which
pulls in the HTTP client). The cost of that choice is that the event name and payload are a contract
duplicated across files, and each copy carries a comment saying so.

| Event                           | Declared in                                                               | Dispatched by                                                                                                                         | Consumed by                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `powersync_credentials_invalid` | [connector.ts:21](../../src/db/powersync/connector.ts)                    | Connector token refresh, `HttpClient.afterResponse` ([http.ts:240](../../src/lib/http.ts)), Better Auth `onError`, cross-tab listener | [use-powersync-credentials-invalid-listener.ts:67](../../src/hooks/use-powersync-credentials-invalid-listener.ts)                                                      |
| `show_sign_in_modal`            | [use-credential-events.ts:11](../../src/hooks/use-credential-events.ts)   | The listener above, on `session_expired`                                                                                              | [SignInModalProvider](../../src/contexts/sign-in-modal-context.tsx)                                                                                                    |
| `sign_in_success`               | [use-credential-events.ts:14](../../src/hooks/use-credential-events.ts)   | `SignInModalProvider` after a successful re-auth                                                                                      | The credentials-invalid listener, to reset its dedup ref                                                                                                               |
| `show_revoked_device_modal`     | [use-credential-events.ts:8](../../src/hooks/use-credential-events.ts)    | The credentials-invalid listener                                                                                                      | [useCredentialEvents](../../src/hooks/use-credential-events.ts) in `App`                                                                                               |
| `app_version_unsupported`       | [app-version-unsupported.ts:13](../../src/lib/app-version-unsupported.ts) | `handleAppVersionUnsupported` on a 426 (or an `APP_VERSION_UNSUPPORTED` body code) from our backend                                   | [useAppVersionUnsupportedListener](../../src/hooks/use-app-version-unsupported-listener.ts) and the sync layer ([database.ts:227](../../src/db/powersync/database.ts)) |

Three properties of the 401 path are load-bearing:

- **Only a 401 against an _existing_ token is an expiry.** Better Auth's `onError` captures token presence
  before clearing it, so a 401 from sign-in or OTP-verify — where there is no stored token — does not pop
  the sign-in modal ([auth-context.tsx:169-179](../../src/contexts/auth-context.tsx)).
- **Only _our_ backend's 401s count.** `HttpClient` is also used for external APIs with caller-supplied
  OAuth tokens, so both its `beforeRequest` and `afterResponse` hooks gate on `isBackendRequest`
  ([src/lib/http.ts:95-103](../../src/lib/http.ts)) before setting the device, version and language headers
  or reading a status as a session signal. The bearer token is the exception: it is set on any request that
  does not already carry an `Authorization` header, so a caller hitting a third-party API through this
  client must supply its own ([http.ts:201-206](../../src/lib/http.ts)).
- **`session_expired` yields to a revocation or a deletion.** The listener's refs make a real device
  revocation or account reset win, rather than stacking a sign-in modal on top of a teardown
  ([use-powersync-credentials-invalid-listener.ts:93-106](../../src/hooks/use-powersync-credentials-invalid-listener.ts)).
  The expiry path itself clears the token and stops sync but keeps the database, the encryption keys and
  the device id.

`app_version_unsupported` mirrors the same pattern for the version gate described in
[AGENTS.md § App version gate](../../AGENTS.md#app-version-gate). `handleAppVersionUnsupported`
([app-version-unsupported.ts:46-52](../../src/lib/app-version-unsupported.ts)) latches a module-level flag
**before** dispatching, so a caller that reads the latch rather than the event still sees the block:
`isAppVersionUnsupported()` ([src/lib/app-version.ts:49](../../src/lib/app-version.ts)) ORs that latch with
the persisted `/config` minimum, and every sync entry point consults it
([database.ts:250](../../src/db/powersync/database.ts)). That matters because a version-blocked client
holding a sync stream would queue writes in `ps_crud` and flush them after the upgrade, before the E2EE
keyring is provisioned ([src/db/powersync/database.ts:207-218](../../src/db/powersync/database.ts)).

## The header contract

Every request to our backend carries the bearer token, device identity, `X-App-Version` and
`X-App-Language`. Two implementations produce that set, and they must stay in step:

- `HttpClient`'s `beforeRequest` hook ([src/lib/http.ts:199-223](../../src/lib/http.ts)) — for anything
  holding a client.
- `getAuthenticatedHeaders()` ([src/lib/auth-token.ts:83](../../src/lib/auth-token.ts)) — for callers that
  cannot, notably the PowerSync connector.

Better Auth requests are a third path with a trap of its own: better-fetch **replaces** rather than merges
the headers object, so a call passing `fetchOptions.headers` drops the client-level set and 426s on a
current build. `authRequestHeaders()` ([auth-context.tsx:123](../../src/contexts/auth-context.tsx)) exists
for that, applied through `onRequest` so it survives the shallow spread, and re-read per request so the
locale is not frozen at client construction. See
[AGENTS.md § App version gate](../../AGENTS.md#app-version-gate) and
[§ The `X-App-Language` header](../../AGENTS.md#the-x-app-language-header) for the rules these headers follow.

## Signing out

`LogoutModal` ([src/components/logout-modal.tsx:42-62](../../src/components/logout-modal.tsx)) calls
`authClient.signOut()`, then `clearLocalData({ clearDatabase })` with the user's choice of keeping or
deleting the local database, then replaces the location — `/signed-out` in SSO mode, a plain reload
otherwise. Both steps log and continue on failure: a sign-out that cannot reach the server must still
clear the device.

## Where the code lives

| File                                                                                                                     | Role                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [src/lib/auth-token.ts](../../src/lib/auth-token.ts)                                                                     | localStorage credentials, header builder, cross-tab subscription |
| [src/lib/session-cache.ts](../../src/lib/session-cache.ts)                                                               | Offline session cache and its validity rule                      |
| [src/lib/auth-mode.ts](../../src/lib/auth-mode.ts)                                                                       | The three build-time mode flags                                  |
| [src/contexts/auth-context.tsx](../../src/contexts/auth-context.tsx)                                                     | Better Auth client construction, fetch hooks, provider effects   |
| [src/contexts/sign-in-modal-context.tsx](../../src/contexts/sign-in-modal-context.tsx)                                   | Re-auth modal, dismissal routing, post-sign-in sync enablement   |
| [src/components/auth-gate/use-auth-gate.ts](../../src/components/auth-gate/use-auth-gate.ts)                             | Route access decision                                            |
| [src/lib/http.ts](../../src/lib/http.ts)                                                                                 | Authenticated client, header injection, 401/426 hooks            |
| [src/lib/app-version-unsupported.ts](../../src/lib/app-version-unsupported.ts)                                           | 426 latch and event                                              |
| [src/hooks/use-powersync-credentials-invalid-listener.ts](../../src/hooks/use-powersync-credentials-invalid-listener.ts) | Single consumer of the credentials-invalid event                 |
| [src/lib/cleanup.ts](../../src/lib/cleanup.ts)                                                                           | The one teardown path                                            |

Tests sit beside each: `src/lib/auth-token.test.ts`, `src/lib/session-cache.test.ts`,
`src/contexts/auth-context.test.ts`, `src/components/auth-gate/use-auth-gate.test.ts`.
