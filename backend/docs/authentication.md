# Authentication

Every credential resolves to a Better Auth session. Everything downstream (the `auth: true` route macro, PowerSync token issuance, device binding) only ever sees the session.

| Credential               | Minted by                                         | Plugin / gate                                       | Documented in                                            |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| Email OTP session        | `POST /v1/api/auth/sign-in/email-otp`             | `emailOTP` plugin                                   | [below](#email-sign-in-otp-bound-to-a-challenge-token)   |
| Enterprise SSO session   | `/v1/api/auth/sso/*`                              | `AUTH_MODE=oidc` or `saml`                          | [OIDC](./oidc-local-dev.md), [SAML](./saml-local-dev.md) |
| CLI device-grant session | `POST /v1/api/auth/device/token`                  | `deviceAuthorization` plugin                        | [below](#the-cli-device-grant-rfc-8628)                  |
| Anonymous session        | `POST /v1/api/auth/sign-in/anonymous`             | `AUTH_ALLOW_ANONYMOUS=true`                         | [below](#anonymous-sessions)                             |
| Personal access token    | `x-api-key` header, resolved to its owner         | `apiKey` plugin                                     | [pat-lifecycle.md](./pat-lifecycle.md)                   |
| Passkey session          | `POST /v1/api/auth/passkey/verify-authentication` | `passkey` plugin, `PASSKEY_ENABLED` + consumer mode | [below](#passkeys)                                       |

The stack is assembled in [`backend/src/auth/auth.ts`](../src/auth/auth.ts), mounted at `basePath: '/v1/api/auth'`.

## The session layer

`createAuth` is a factory, not a singleton, so tests inject their own database and email senders (`AuthEmailDeps`) instead of `mock.module()`, which leaks across files in the same Bun worker.

Sessions carry three fields beyond Better Auth's own:

| Field              | Why it exists                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `user.isNew`       | Cleared by the sign-in after-hook.                                                                                                 |
| `user.isAnonymous` | Exposed on the session so the PowerSync route guard needs no extra query.                                                          |
| `session.deviceId` | Binds a session to one device. See [powersync-account-devices.md](../../docs/internals/architecture/powersync-account-devices.md). |

### Bearer tokens are signed, and the signature is not optional

A credential is `rawSessionToken.base64Signature`, the same value Better Auth puts in the session cookie. The `bearer` plugin runs with `requireSignature: true` and checks the signature before looking the session up. **A bare session token, read out of the database or out of a `/device/token` response body, will not authenticate.**

[`bearer-token.ts`](../src/auth/bearer-token.ts)'s `verifySignedBearerToken` mirrors the check (HMAC-SHA256 over the raw token, `timingSafeEqual` on the digests) for routes needing the raw token: the CLI device endpoints in [`api/account.ts`](../src/api/account.ts) verify with `settings.betterAuthSecret`, then read the session row directly.

### Mounting and rate limits

Routes opt in with the `auth: true` macro from [`elysia-plugin.ts`](../src/auth/elysia-plugin.ts), which mounts Better Auth with `.all('/api/auth/*')`. Not Elysia's `.mount()`: it short-circuits before `onBeforeHandle` and would silently bypass the IP rate limiter `index.ts` passes in.

| Limiter                                      | Scope                                   | Budget                                            |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `createAuthIpRateLimit` (the `auth` IP tier) | DB-backed; holds across replicas        | See [rate-limiting.md](./rate-limiting.md)        |
| Better Auth's own                            | In-memory, single-instance defence only | 10 requests / 60s; `/get-session` relaxed to 30/s |

Both read the client IP through `TRUSTED_PROXY` (`getTrustedIpHeaders(settings.trustedProxy)` feeds Better Auth's `ipAddressHeaders`). `createAuth` warns at startup when it is unset in production: `x-forwarded-for` is spoofable without a proxy in front, so the limiter would key on attacker-supplied values.

`trustedOrigins` always includes `tauri://localhost` (the desktop and mobile origin) and the backend's own origin, so the SSO desktop callback can be a `callbackURL`.

## Email sign-in: OTP bound to a challenge token

```text
POST /v1/waitlist/join           { email }         → { success: true, challengeToken? }
   (email arrives: 8-digit code + /auth/verify link)
POST /v1/api/auth/sign-in/email-otp                → session
   headers: x-challenge-token: <challengeToken>
```

`AUTH_MODE=consumer` configures neither `emailAndPassword` nor any `socialProviders`: the only credential is an 8-digit code, sent as both a code to type and a link to click. A code alone is guessable without touching the victim's browser, so the **challenge token** binds it to the client session that asked for it.

### The challenge token

One row per email in `otp_challenge` ([`otp-challenge-schema.ts`](../src/db/otp-challenge-schema.ts)), `email` unique, deleted by the sign-in after-hook and otherwise expiring with the code (`otpExpirySeconds = 600`, [`otp-constants.ts`](../src/auth/otp-constants.ts)).

`getOrCreateOtpChallenge` ([`otp-challenge.ts`](../src/dal/otp-challenge.ts)) is **first-writer-wins**: `ON CONFLICT ... DO UPDATE ... WHERE expires_at < now()`, then reads the row back rather than returning what it wrote, so two instances racing on one address hand out the same token. Both callers use it: `/v1/waitlist/join`, and `sendVerificationOTP` when a client hits Better Auth's send-OTP endpoint directly.

Two hooks in `auth.ts`, scoped to `/sign-in/email-otp`:

- **before**: missing `x-challenge-token` or `email` is `UNAUTHORIZED` (`Challenge token required`); a token with no live row for that email is `UNAUTHORIZED` (`Invalid challenge token`). The token is deliberately _not_ consumed here, so Better Auth's 3-attempt counter still gets its three attempts. It then re-checks the waitlist: an address with no `user` row and no `approved` entry is refused even with a valid token.
- **after**: deletes the challenge rows for that email, clears `isNew` on first sign-in.

A separate table rather than a field on the `verification` row, because `/v1/waitlist/join` issues the token before Better Auth is involved, and it must outlive individual attempts so the attempt counter is what stops a guessing client.

### Defence in depth

| Control                   | Where                                                                    | Why                                                                                               |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 8-digit code              | `otpLength: 8` in `auth.ts`                                              | 100M keyspace                                                                                     |
| 3 attempts                | `allowedAttempts: 3`                                                     | Better Auth returns `TOO_MANY_ATTEMPTS` past this                                                 |
| `resendStrategy: 'reuse'` | `auth.ts`                                                                | A resend reuses the existing code, so it cannot reset the attempt counter                         |
| 15s per-email cooldown    | `defaultCooldownMs` in [`waitlist/routes.ts`](../src/waitlist/routes.ts) | Blocks rapid code cycling; recorded before any async work so concurrent requests cannot both pass |
| Challenge token           | `otp_challenge` + the before-hook                                        | Binds the code to the requesting client                                                           |

The cooldown map is per-instance, in-memory, pruned past 1000 entries.

`otpLength` and the header name are duplicated on the client in [`src/lib/constants.ts`](../../src/lib/constants.ts). Changing either means changing both.

### The magic link is the same code

`buildVerifyUrl` ([`utils.tsx`](../src/auth/utils.tsx)) builds `${appUrl}/auth/verify?email=…&otp=…&challengeToken=…`. There is no second verification endpoint: [`magic-link-verify.tsx`](../../src/components/magic-link-verify.tsx) reads the three params and calls the same `signIn.emailOtp` with the same header. The host is always the app URL, so iOS Universal Links and Android App Links route it into the installed app.

### What the client must do

```text
authClient.signIn.emailOtp({ …, fetchOptions: { headers: authRequestHeaders({ [challengeTokenHeader]: token }) } })
```

See [`use-sign-in-form-state.ts`](../../src/components/sign-in/use-sign-in-form-state.ts) and [`use-waitlist-state.ts`](../../src/waitlist/use-waitlist-state.ts). Better Auth merges a per-call `headers` object with the client's headers, and `buildFetchOptions` adds `X-App-Version` to every request in `onRequest`, so the [app version gate](../../AGENTS.md#app-version-gate) always sees it.

Sign-in errors: `OTP_EXPIRED`, `INVALID_OTP`, `TOO_MANY_ATTEMPTS` (Better Auth), plus the before-hook's 401s; display mapping in [`otp-error-messages.ts`](../../src/lib/otp-error-messages.ts). `/v1/waitlist/join` answers `429 { error: 'code_already_sent' }` inside the cooldown, otherwise always `{ success: true }`. `challengeToken` is present only for an address allowed to sign in, so the response does not disclose account existence.

### The waitlist is always on

`sendVerificationOTP` runs the waitlist check regardless of `WAITLIST_ENABLED` ([configuration.md](../../docs/self-hosting/configuration.md)). A new address gets a `pending` entry and the "joined" email; a still-pending address gets the "not ready" email. Neither reply carries a code, and `deletePersistedSignInOtp` removes the one Better Auth already wrote to `verification`, which would otherwise exist for an account not allowed to use it.

Addresses matching `isAutoApprovedDomain` skip straight to approved.

Email locale comes from the `X-App-Language` header on the triggering request, never a stored column. Call-shape traps: [transactional email in AGENTS.md](../../AGENTS.md#transactional-email-backend).

## Enterprise SSO

`AUTH_MODE=oidc` or `saml` swaps the login page for an IdP redirect; `buildSsoPlugins` throws at startup if the mode's env vars are missing. Setup and the web redirect chain: [oidc-local-dev.md](./oidc-local-dev.md), [saml-local-dev.md](./saml-local-dev.md).

SSO mode passes a `resolveUser` hook to the `sso` plugin (`linkSsoToKnownEmailOwner` in [`auth.ts`](../src/auth/auth.ts)). The hook runs on every SSO sign-in, before Better Auth looks the identity up, so it first lets an identity that already has an `sso` account through to its own user. This keeps a returning user signing in to their own account even after the IdP changes their email to another user's address. For a new identity whose email matches an existing user, it links the identity to that user when the user's email is verified locally (they signed in with an emailed code), or when the user already has an identity from the `sso` provider. The second case covers a new identity for the same person: switching `AUTH_MODE` between `oidc` and `saml`, a different IdP, or an IdP that changes the subject or NameID. It never links when an OIDC id_token or userinfo says `email_verified` is false (boolean `false` or the string `"false"`), and that sign-in fails with "account not linked". SAML has no such claim. A new email creates a user as before. A user never verified locally and with no `sso` identity is refused with "account not linked".

A user the IdP creates is stored with `emailVerified: false`, because we do not use the IdP's claim to verify. That user keeps signing in while the IdP sends the same subject (OIDC) or NameID (SAML), since Better Auth finds the account by that ID first. A changed ID falls through to the email match and links through the `sso` identity the user already has.

For an OIDC IdP that reports `email_verified` false, the fix is at the IdP: mark the address verified. Keycloak marks an address verified only when the realm requires "Verify email" or an admin ticks "Email verified". When Keycloak loads users from LDAP, it sends `email_verified` false unless "Trust Email" is turned on in the LDAP user federation settings, so turn it on. For an account refused because it was never verified locally and has no `sso` identity, the operator confirms the person, checks the account has no sign-in method they didn't set up (a foreign provider row could have created it), and sets `email_verified` on that `user` row ([troubleshooting](../../docs/troubleshooting.md#account-not-linked)), never deleting the row.

What we trust is the one IdP the operator configured through env, and only after Better Auth has checked the SAML signature or the OIDC id_token. Better Auth does not trust a provider by name for SSO, so without the hook every user who first signed in by email code would hit "account not linked" on their first SSO sign-in.

That IdP must be the only one. Better Auth still reads `sso_provider` rows, which older releases let any signed-in user add through `/sso/register`, and a row's owner controls its IdP: with `resolveUser` in place, that IdP would sign them in as any verified user. So in SSO mode the before-hook in `createAuth` (`isForeignSsoRequest`) refuses every SSO route except sign-in, the OIDC callback, the SAML ACS and the SP metadata, and refuses those unless they name the `sso` provider. `providersLimit: 0` stops new rows. Operators delete the old ones ([upgrading](../../docs/self-hosting/upgrading.md#single-sign-on-changes)).

SAML refuses a response that carries no `InResponseTo`, which is a login started at the IdP dashboard. `SAML_ALLOW_IDP_INITIATED=true` turns that on (`saml.allowIdpInitiated`). `saml.idpInitiatedCallbackUrl` is `APP_URL`: such a response has no RelayState, so without it Better Auth redirects, accepted or refused, to the API origin instead of the app.

Both sign-in requests send `errorCallbackURL`, because Better Auth sends a failed login to its own `/error` page on the API host when it is missing. The web app sends `/sso-error` ([`sso-error.tsx`](../../src/components/sso-error.tsx), which maps the `error` code to copy and never shows it raw). `desktop-initiate` sends the `desktop-callback` URL, which forwards `error` to the loopback instead of looking for a session. SAML sends an unlinkable account to the callback URL, not the error URL, and a refused IdP-initiated response (`unsolicited_response`) to `APP_URL`, so `useAuthGate` turns an `?error=` on `/` into `/sso-error`. A login attempt whose state expired still ends on Better Auth's own `/error` page; `onAPIError.errorURL` would cover that and is not set.

The hook runs inside a database transaction and Better Auth refuses to call it otherwise, so SSO mode turns on `transaction` in the Drizzle adapter. Consumer mode keeps the plain adapter.

### The desktop bridge (Tauri)

```text
app  → start_oauth_server (Rust) binds a loopback port
     → system browser opens /v1/api/auth/sso/desktop-initiate?loopback_port=N
         → backend POSTs Better Auth /sign-in/sso, forwards its Set-Cookie headers,
           sets a nonce cookie, 302s the browser to the IdP
     → IdP authenticates, Better Auth 302s to /v1/api/auth/sso/desktop-callback?loopback_port=N
         → backend reads the session cookie (already a signed bearer) and 302s to
           http://127.0.0.1:N/?token=…
     → Rust server emits `oauth-callback`; the app stores the token
```

Tauri cannot use the web chain: WKWebView drops cookies across the cross-origin redirects. Desktop follows RFC 8252 (system browser plus loopback listener), bridged by two endpoints in [`sso-desktop-callback.ts`](../src/auth/sso-desktop-callback.ts). Client half: [`sso-loopback.ts`](../../src/lib/sso-loopback.ts), reached from [`sso-redirect.tsx`](../../src/components/sso-redirect.tsx), which branches on `isTauri()`.

- **Port allowlist, hard-coded on both sides.** `allowedLoopbackPorts = {17421, 17422, 17423}` in `sso-desktop-callback.ts` must match `OAUTH_PORTS` in [`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs), and those ports are the redirect URIs registered in the Google and Microsoft OAuth consoles. A port off the list returns a 400 HTML error page, not a redirect.
- **The nonce cookie is a CSRF control, checked for presence only.** `thunderbolt_desktop_sso_nonce` is `HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=600` (plus `Secure` when initiate arrived over HTTPS), set only by `desktop-initiate`, cleared by `desktop-callback`. The protection is in the attributes; validating the value server-side would need a session store for no gain.
- **Both routes are a no-op under `AUTH_MODE=consumer`.** `createSsoDesktopCallbackRoutes` returns an empty router, so `desktop-initiate` 404s rather than failing later with a confusing 502.
- **`desktop-initiate` calls Better Auth over HTTP** at `settings.betterAuthUrl` rather than through the internal API, which keeps it working behind a reverse proxy and uncoupled from Better Auth internals, at one network hop.
- `/v1/api/auth/sso` is in `appVersionExemptPrefixes` ([`app-version.ts`](../src/middleware/app-version.ts)): browser redirects carry no `X-App-Version`, and the gate is fail-closed.

## The CLI device grant (RFC 8628)

```text
POST /v1/api/auth/device/code    { client_id }            → device_code, user_code, interval, expires_in,
                                                            verification_uri, verification_uri_complete
user opens ${APP_URL}/device (or the verification_uri_complete link / QR) and approves
POST /v1/api/auth/device/token   { grant_type: urn:ietf:params:oauth:grant-type:device_code, … }
                                                          → 400 authorization_pending | slow_down
                                                          → 200 + set-auth-token: <signed bearer>
```

`thunderbolt login` has no browser, so it uses Better Auth's `deviceAuthorization` plugin with `verificationUri: ${appUrl}/device`, derived from `APP_URL` so a self-hoster's frontend is used with nothing hard-coded. `DEVICE_AUTH_EXPIRES_IN` (`30m`) and `DEVICE_AUTH_INTERVAL` (`5s`) are in [configuration.md](../../docs/self-hosting/configuration.md).

**The usable credential is the `set-auth-token` response header, not the body's `access_token`.** The token endpoint mints a session without a cookie, so the bearer plugin's after-hook has nothing to expose, and the body's raw session token is unsigned and fails `requireSignature`. The `auth.ts` after-hook re-signs with `makeSignature` and adds `set-auth-token` to `Access-Control-Expose-Headers`, merging rather than overwriting. The CLI treats a missing header as a hard error ([`http-transport.ts`](../../cli/src/auth/http-transport.ts)).

The polling loop ([`device-grant.ts`](../../cli/src/auth/device-grant.ts)) is a pure state machine with injected clock and transport. It polls immediately rather than sleeping first (a short-lived code could otherwise expire before the first request), widens the interval by 5s on `slow_down`, and keeps a deadline from `expires_in` as a backstop to the server's `expired_token`.

Approval happens at [`device-approval.tsx`](../../src/components/device-approval.tsx), which needs a signed-in **real** account: an anonymous visitor gets the sign-in modal in place, not a redirect that would loop through the authenticated home route.

`/v1/api/auth/device` is in `appVersionExemptPrefixes`: the polling client is headless.

### The pending-device marker

Sessions from `/device/token` are stamped `session.deviceId = 'cli-registration-pending'` by the `databaseHooks.session.create.before` hook (`cliRegistrationPendingDeviceId`, [`dal/sessions.ts`](../src/dal/sessions.ts)): from the device grant, no device row claimed yet. The CLI then calls `PUT /v1/account/devices/cli` ([`api/account.ts`](../src/api/account.ts)) with `x-device-id`, `x-device-name` and `x-app-version`, upserting the device row and swapping the marker for the real id inside a per-user registration lock.

| Response                                                          | Status |
| ----------------------------------------------------------------- | ------ |
| `INVALID_DEVICE_ID`, `INVALID_DEVICE_NAME`, `INVALID_APP_VERSION` | 400    |
| `DEVICE_DISCONNECTED`                                             | 403    |
| `SESSION_DEVICE_MISMATCH`, `DEVICE_ID_TAKEN`                      | 409    |
| `DEVICE_LIMIT_REACHED`                                            | 422    |
| Route absent unless `CLI_DEVICE_REGISTRATION_ENABLED=true`        | 404    |

Until the swap, `rejectUnregisteredCliDevice` ([`inference/cli-device.ts`](../src/inference/cli-device.ts)) answers `409 CLI_DEVICE_NOT_BOUND` on the managed-inference, confidential and usage-receipt routes: a device-grant session is not usable for metered work until it is attributable to a device the user can see and revoke.

Both halves ride the same kill switch: with `CLI_DEVICE_REGISTRATION_ENABLED` unset the marker is still stamped but the check returns early, so the session reaches those routes unregistered.

## Personal access tokens

The `apiKey` plugin runs with `enableSessionForAPIKeys: true`, so `x-api-key` authenticates as the key's owner, and with its per-key rate limit **disabled**: the 10 requests/day default is unusable for automation, and the account/IP limits still apply.

A PAT registers no CLI device, so `rejectUnregisteredCliDevice` returns early for any request carrying `x-api-key` rather than looking for a device row that will never exist. Lifecycle, expiry and the confidential-model gate: [pat-lifecycle.md](./pat-lifecycle.md).

## Anonymous sessions

The `anonymous` plugin is registered only when `AUTH_ALLOW_ANONYMOUS=true`; otherwise `/v1/api/auth/sign-in/anonymous` 404s, so a client bypassing the `VITE_AUTH_ENABLE_ANONYMOUS` overlay gains nothing.

- The before-hook rejects `/sign-in/anonymous` when the caller already holds a non-anonymous session (session fixation).
- `disableDeleteAnonymousUser: true` closes Better Auth's unauthenticated `/delete-anonymous-user`; the anonymous row is deleted from `onLinkAccount` when the account is promoted.
- With Better Auth's cleanup off, `sweepIdleAnonymousUsers` ([idle-anonymous-users.ts](../src/auth/idle-anonymous-users.ts)) hard-deletes anonymous users idle for more than `ANONYMOUS_USER_IDLE_DAYS` (default 30, `0` disables) at startup and hourly, through the same cascading `user` delete as account deletion. Activity is defined in `deleteIdleAnonymousUsers` ([users.ts](../src/dal/users.ts)).

Anonymous sign-in is intentionally _not_ waitlist-gated: trying the app without an account is the feature.

## Passkeys

The `passkey` plugin is registered only when `isPasskeyEnabled` holds (`PASSKEY_ENABLED=true` on a consumer-auth deployment); otherwise every `/passkey/*` route 404s. Sign-in (`generate-authenticate-options` → `verify-authentication`) needs no session. Management routes go through the before-hook. It runs ahead of the bearer plugin, so it looks the caller up with `auth.api.getSession` (`getSessionFromCtx` can't see a bearer-only session there), and then:

- refuses anonymous users;
- refuses API-key and CLI device-grant sessions (`isCliGrantSession`), so a delegated credential can never mint a permanent interactive sign-in;
- allows one passkey per account, checked at both registration steps and backed by a unique index on `passkey.user_id`;
- lets the plugin's own rule stand that registration needs a session under a day old (`SESSION_NOT_FRESH`, Better Auth's default `freshAge`). When sync setup hits it, the user confirms with a code sent to the account's own email and signs in again in place. The email can't be changed, so it's the same account and the device keeps its keys and data;
- refuses to delete a passkey that still holds the account's E2EE passkey slot (`passkeyHoldsSyncSlot`); the client clears the slot with an AK rotation first.

The plugin keeps the WebAuthn challenge in a signed cookie, but the Apple apps' webview never stores it: every API call from `tauri://localhost` is cross-site. So `elysia-plugin.ts` copies the cookie into an `X-Passkey-Challenge` header on the two options responses, and turns that header back into the cookie on the verify calls; the client sends no cookies at all. That cookie makes Better Auth check the verify calls' Origin, which is why `parseTrustedOrigins` always trusts the Android and Windows apps' `http://tauri.localhost` alongside `tauri://localhost`. The Windows app runs the ceremony through `webauthn.dll`, which takes the clientDataJSON from the caller, so the app presents `https://{PASSKEY_RP_ID}` as its WebAuthn origin and needs no setting like `PASSKEY_ANDROID_ORIGINS`. Older web builds still send cookies on ceremonies, so the plugin also strips any stale Better Auth session cookie — both the plain and `__Secure-` names — from passkey requests that carry a bearer token. The E2EE side of the passkey is in [e2e-encryption.md](../../docs/internals/architecture/e2e-encryption.md#the-passkey-slot-a-second-virtual-device).

## Tests

All in `backend/src/auth/`, run with `bun run test:backend`:
[`otp-security.test.ts`](../src/auth/otp-security.test.ts) (challenge binding, attempt counter, resend),
[`waitlist-integration.test.ts`](../src/auth/waitlist-integration.test.ts),
[`device-auth-apikey.test.ts`](../src/auth/device-auth-apikey.test.ts),
[`auth-passkey.test.ts`](../src/auth/auth-passkey.test.ts),
[`sso-desktop-callback.test.ts`](../src/auth/sso-desktop-callback.test.ts),
[`oidc-integration.test.ts`](../src/auth/oidc-integration.test.ts),
[`saml-integration.test.ts`](../src/auth/saml-integration.test.ts).
