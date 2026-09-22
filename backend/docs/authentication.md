# Authentication

Every credential in Thunderbolt resolves to one thing: a Better Auth session. Four flows mint a session row — consumer email OTP, enterprise SSO, the CLI device grant, and anonymous sign-in where the operator has enabled it — and the personal access token is resolved into a session for its owner by the `apiKey` plugin. Everything downstream (the `auth: true` route macro, PowerSync token issuance, device binding) only ever sees the session.

The stack is assembled in one place, [`backend/src/auth/auth.ts`](../src/auth/auth.ts), mounted at `basePath: '/v1/api/auth'`. This page covers the flows that have no other home. The two enterprise SSO setup guides are separate: [OIDC](./oidc-local-dev.md) and [SAML](./saml-local-dev.md). PAT creation and revocation are in [pat-lifecycle.md](./pat-lifecycle.md).

## The session layer

`createAuth` is a factory, not a singleton, so tests inject their own database and email senders (`AuthEmailDeps`) instead of reaching for `mock.module()`, which leaks across files in the same Bun worker.

Sessions carry three fields beyond Better Auth's own: `user.isNew` (cleared by the sign-in after-hook, see below), `user.isAnonymous` (exposed on the session so the PowerSync route guard needs no extra query), and `session.deviceId` (the binding that makes a session attributable to one device — see [powersync-account-devices.md](../../docs/architecture/powersync-account-devices.md)).

**Bearer tokens are signed, and the signature is not optional.** The `bearer` plugin runs with `requireSignature: true`, so a credential is `rawSessionToken.base64Signature` — the same value Better Auth puts in the session cookie — and the plugin checks the signature before it looks the session up. `verifySignedBearerToken` ([`bearer-token.ts`](../src/auth/bearer-token.ts)) mirrors that check in this codebase (HMAC-SHA256 over the raw token, `timingSafeEqual` on the digests) for the routes that need the raw token rather than a resolved session: the CLI device endpoints in [`api/account.ts`](../src/api/account.ts) verify with `settings.betterAuthSecret` and then read the session row directly. A bare session token read out of the database, or out of a `/device/token` response body, will not authenticate. This is the detail most easily got wrong when writing a new client.

Routes opt into authentication with the `auth: true` macro from [`elysia-plugin.ts`](../src/auth/elysia-plugin.ts). Note that the plugin mounts Better Auth with `.all('/*')` rather than Elysia's `.mount()`: `mount()` short-circuits the pipeline before `onBeforeHandle`, which would silently bypass the IP rate limiter `index.ts` passes in.

Two limiters cover the auth endpoints. The DB-backed `auth` IP tier (`createAuthIpRateLimit`) is the one that holds across replicas; Better Auth's own — 60-second window, 10 requests, `/get-session` relaxed to 30 per second — is in-memory and therefore **single-instance defence only**, which is why THU-113 tracks replacing it with a proof-of-work challenge. Both read the client IP through `TRUSTED_PROXY`: `getTrustedIpHeaders(settings.trustedProxy)` feeds Better Auth's `ipAddressHeaders`, and `createAuth` warns at startup when the variable is unset in production, because `x-forwarded-for` is spoofable without a proxy in front and the limiter would key on attacker-supplied values. [rate-limiting.md](./rate-limiting.md) has the full picture.

`trustedOrigins` always includes `tauri://localhost` (the desktop and mobile app's own origin) and the backend's own origin, the latter so the SSO desktop callback below can be used as a `callbackURL`.

## Consumer sign-in: email OTP bound to a challenge token

In `AUTH_MODE=consumer` the stack configures neither `emailAndPassword` nor any `socialProviders`, so the only sign-in credential is an 8-digit code, delivered by email as both a code to type and a link to click. An 8-digit code is 100 million values, but a code alone is still a credential an attacker can guess at without ever touching the victim's browser. The **challenge token** removes that: the code is only accepted from the client session that asked for it.

```text
POST /v1/waitlist/join           { email }         → { success: true, challengeToken? }
   (email arrives: 8-digit code + /auth/verify link)
POST /v1/api/auth/sign-in/email-otp                → session
   headers: x-challenge-token: <challengeToken>
```

The challenge token lives in the `otp_challenge` table ([`otp-challenge-schema.ts`](../src/db/otp-challenge-schema.ts)) — one row per email, `email` unique. `getOrCreateOtpChallenge` ([`otp-challenge.ts`](../src/dal/otp-challenge.ts)) is **first-writer-wins**: the insert uses `ON CONFLICT ... DO UPDATE ... WHERE expires_at < now()`, so a still-valid token is never replaced, and the function reads the row back rather than returning what it tried to write. Two backend instances racing on the same address therefore hand out the same token. Both callers go through the same function: `/v1/waitlist/join` on the normal path, and `sendVerificationOTP` itself when a client reaches Better Auth's own send-OTP endpoint instead. The row is deleted by the sign-in after-hook once a session exists, and otherwise expires with the code (`otpExpirySeconds = 600`, [`otp-constants.ts`](../src/auth/otp-constants.ts)).

Two hooks in `auth.ts` enforce the binding, both scoped to the `/sign-in/email-otp` path:

- **before** — a request with no `x-challenge-token` header or no `email` is `UNAUTHORIZED` (`Challenge token required`); a token that does not match a live row for that email is `UNAUTHORIZED` (`Invalid challenge token`). The token is deliberately _not_ consumed here, so Better Auth's own 3-attempt counter still gets its three attempts. The hook then re-checks the waitlist as defence in depth: an address with no `user` row and no `approved` waitlist entry is refused even if it somehow holds a valid token.
- **after** — deletes the challenge rows for that email and clears `isNew` on a first sign-in.

Why a separate table rather than a field on Better Auth's `verification` row: the token is normally issued by `/v1/waitlist/join`, before Better Auth is involved at all, and it has to outlive individual verification attempts so that the 3-attempt counter — not the challenge — is what stops a guessing client.

### Defence in depth, and why each part is load-bearing

| Control                   | Where                                                                    | Why                                                                                               |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 8-digit code              | `otpLength: 8` in `auth.ts`                                              | 100M keyspace                                                                                     |
| 3 attempts                | `allowedAttempts: 3`                                                     | Better Auth returns `TOO_MANY_ATTEMPTS` past this                                                 |
| `resendStrategy: 'reuse'` | `auth.ts`                                                                | A resend reuses the existing code, so it cannot reset the attempt counter                         |
| 15s per-email cooldown    | `defaultCooldownMs` in [`waitlist/routes.ts`](../src/waitlist/routes.ts) | Blocks rapid code cycling; recorded before any async work so concurrent requests cannot both pass |
| Challenge token           | `otp_challenge` + the before-hook                                        | Binds the code to the requesting client                                                           |

The cooldown map is per-instance and in-memory — like the Better Auth limiter, a single-instance control, pruned when it exceeds 1000 entries.

`otpLength` is duplicated on the client as `otpLength` in [`src/lib/constants.ts`](../../src/lib/constants.ts) (the input renders that many boxes), as is the header name. Changing either means changing both.

### The magic link is the same code

`buildVerifyUrl` ([`utils.tsx`](../src/auth/utils.tsx)) builds `${appUrl}/auth/verify?email=…&otp=…&challengeToken=…`. There is no second verification endpoint: [`src/components/magic-link-verify.tsx`](../../src/components/magic-link-verify.tsx) pulls the three params off the URL and calls the same `signIn.emailOtp` with the same header. The host is always the app URL, so iOS Universal Links and Android App Links route it into the installed app.

### What the client must do

`authClient.signIn.emailOtp({ …, fetchOptions: { headers: authRequestHeaders({ [challengeTokenHeader]: token }) } })` — see [`use-sign-in-form-state.ts`](../../src/components/sign-in/use-sign-in-form-state.ts) and [`use-waitlist-state.ts`](../../src/waitlist/use-waitlist-state.ts). `authRequestHeaders` is mandatory, not stylistic: Better Auth **replaces** client-level headers with a per-call `headers` object rather than merging, so a bare object drops `X-App-Version` and the call 426s under the app-version gate. See the [app version gate section in AGENTS.md](../../AGENTS.md#app-version-gate).

Errors a client will see on the sign-in call: `OTP_EXPIRED`, `INVALID_OTP`, `TOO_MANY_ATTEMPTS` (Better Auth), plus the 401s the before-hook raises. The display mapping is [`src/lib/otp-error-messages.ts`](../../src/lib/otp-error-messages.ts). `/v1/waitlist/join` answers `429 { error: 'code_already_sent' }` inside the cooldown, and otherwise always `{ success: true }` — `challengeToken` is present only for an address that is allowed to sign in, so the response does not disclose account existence.

### The waitlist is always on

`sendVerificationOTP` runs the waitlist check unconditionally, regardless of `WAITLIST_ENABLED` (see the note in [configuration.md](../../docs/self-hosting/configuration.md)). A brand-new address gets a `pending` waitlist entry and the "joined" email; an address whose entry is still pending gets the "not ready" email. Either way the reply carries no code, and `deletePersistedSignInOtp` removes the code Better Auth had already written to the `verification` table — otherwise a code would exist for an account that is not allowed to use it. Addresses matching `isAutoApprovedDomain` skip straight to approved.

Email locale comes from the `X-App-Language` header on the request that triggered the send, never a stored column; the reasoning and the call-shape traps are in the [transactional email section of AGENTS.md](../../AGENTS.md#transactional-email-backend).

## Enterprise SSO

`AUTH_MODE=oidc` or `saml` swaps the login page for a redirect to the IdP; `buildSsoPlugins` throws at startup if the mode's required env vars are missing, so a misconfigured deployment fails loudly rather than serving a broken sign-in. Setup and the browser redirect chain are covered in [oidc-local-dev.md](./oidc-local-dev.md) and [saml-local-dev.md](./saml-local-dev.md).

One decision worth knowing before you debug an "account not linked" error: in SSO mode the `sso` provider is added to `accountLinking.trustedProviders`. The IdP is operator-controlled in a self-hosted enterprise deployment, so linking an SSO identity onto an existing user row with the same email is safe and is what operators expect. Without it, any user record not originally created through the same SSO flow fails at the callback.

### The desktop bridge (Tauri)

The redirect chain in those two guides is the _web_ chain. Tauri cannot use it: WKWebView drops cookies across the cross-origin redirects, so the session cookie never arrives. Desktop instead follows RFC 8252 — system browser plus a loopback listener — bridged by two endpoints in [`sso-desktop-callback.ts`](../src/auth/sso-desktop-callback.ts):

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

The client half is [`src/lib/sso-loopback.ts`](../../src/lib/sso-loopback.ts), reached from [`src/components/sso-redirect.tsx`](../../src/components/sso-redirect.tsx), which branches on `isTauri()`.

Things that will bite:

- **The port allowlist is hard-coded on both sides.** `allowedLoopbackPorts = {17421, 17422, 17423}` in `sso-desktop-callback.ts` must stay in sync with `OAUTH_PORTS` in [`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs); those ports are also the redirect URIs pre-registered in the Google and Microsoft OAuth consoles. A port off the list is a 400 with an HTML error page, not a redirect.
- **The nonce cookie is a CSRF control, checked for presence only.** `thunderbolt_desktop_sso_nonce` is `HttpOnly; SameSite=Lax; Path=/v1/api/auth/sso; Max-Age=600` (plus `Secure` when the initiate request arrived over HTTPS), set only by `desktop-initiate` and cleared by `desktop-callback`. The protection is in the attributes — only a genuine initiate can have set it — so validating the value server-side would need a session store for no real gain.
- **Both routes are a no-op in consumer mode.** `createSsoDesktopCallbackRoutes` returns an empty router when `authMode === 'consumer'`, so `desktop-initiate` 404s rather than failing later with a confusing 502.
- **`desktop-initiate` calls Better Auth over HTTP**, at `settings.betterAuthUrl`, rather than through the internal API. That keeps it working behind a reverse proxy and avoids coupling to Better Auth internals, at the cost of one network hop.
- `/v1/api/auth/sso` is in `appVersionExemptPrefixes` ([`app-version.ts`](../src/middleware/app-version.ts)). It has to be: these are browser redirects with no `X-App-Version` header, and the gate is fail-closed.

## The CLI device grant (RFC 8628)

`thunderbolt login` has no browser of its own, so it uses the device-authorization grant, registered in `auth.ts` via Better Auth's `deviceAuthorization` plugin with `verificationUri: ${appUrl}/device` — derived from `APP_URL` so a self-hoster's own frontend is used with nothing hard-coded. `DEVICE_AUTH_EXPIRES_IN` (`30m`) and `DEVICE_AUTH_INTERVAL` (`5s`) are documented in [configuration.md](../../docs/self-hosting/configuration.md).

```text
POST /v1/api/auth/device/code    { client_id }            → device_code, user_code, interval, expires_in,
                                                            verification_uri, verification_uri_complete
user opens ${APP_URL}/device (or the verification_uri_complete link / QR) and approves
POST /v1/api/auth/device/token   { grant_type: urn:ietf:params:oauth:grant-type:device_code, … }
                                                          → 400 authorization_pending | slow_down
                                                          → 200 + set-auth-token: <signed bearer>
```

**The usable credential is the `set-auth-token` response header, not the `access_token` in the body.** The token endpoint mints a session without setting a cookie, so the bearer plugin's normal after-hook has nothing to expose — and the raw session token in the body is unsigned, so it fails `requireSignature`. The after-hook in `auth.ts` re-signs it with `makeSignature` and adds `set-auth-token` to `Access-Control-Expose-Headers` (merging with whatever is already there, rather than overwriting). The CLI treats a missing header as a hard error: see [`cli/src/auth/http-transport.ts`](../../cli/src/auth/http-transport.ts).

The polling loop is [`cli/src/auth/device-grant.ts`](../../cli/src/auth/device-grant.ts) — a pure state machine with injected clock and transport. It polls immediately rather than sleeping first (a short-lived code could otherwise expire before the first request), widens the interval by 5s on `slow_down`, and keeps a client-side deadline from `expires_in` as a backstop to the server's `expired_token`.

Approval happens in the web app at [`src/components/device-approval.tsx`](../../src/components/device-approval.tsx), which needs a signed-in **real** account: an anonymous visitor gets the sign-in modal in place rather than a redirect that would loop through the authenticated home route.

### The pending-device marker

A session created at `/device/token` is stamped with `session.deviceId = 'cli-registration-pending'` by the `databaseHooks.session.create.before` hook (`cliRegistrationPendingDeviceId`, [`dal/sessions.ts`](../src/dal/sessions.ts)). The marker says "this session came from the device grant and has not yet claimed a device row". The CLI then calls `PUT /v1/account/devices/cli` ([`api/account.ts`](../src/api/account.ts)) with `x-device-id`, `x-device-name` and `x-app-version`, which upserts the device row and swaps the marker for the real id inside a per-user registration lock. It answers `INVALID_DEVICE_ID`, `INVALID_DEVICE_NAME`, `INVALID_APP_VERSION` (400), `SESSION_DEVICE_MISMATCH` / `DEVICE_ID_TAKEN` (409), `DEVICE_DISCONNECTED` (403), or `DEVICE_LIMIT_REACHED` (422), and 404s entirely unless `CLI_DEVICE_REGISTRATION_ENABLED=true`.

Until that swap happens, `rejectUnregisteredCliDevice` ([`inference/cli-device.ts`](../src/inference/cli-device.ts)) answers `409 CLI_DEVICE_NOT_BOUND` on the managed-inference, confidential and usage-receipt routes for a still-marked session — which is the point of the marker: a device-grant session is not usable for metered work until it is attributable to a device the user can see and revoke. Both halves ride the same kill switch: with `CLI_DEVICE_REGISTRATION_ENABLED` unset the marker is still stamped, but the check returns early, so a device-grant session reaches those routes unregistered.

`/v1/api/auth/device` is in `appVersionExemptPrefixes` for the same reason as the SSO prefix: the polling client is headless.

## Personal access tokens

The `apiKey` plugin runs with `enableSessionForAPIKeys: true`, so an `x-api-key` header authenticates as the key's owner, and with its own per-key rate limit **disabled** — the plugin default is 10 requests/day, unusable for automation, and the account/IP limits in this stack still apply. A PAT registers no CLI device, so `rejectUnregisteredCliDevice` ([`inference/cli-device.ts`](../src/inference/cli-device.ts)) returns early for any request carrying `x-api-key` rather than looking for a device row that will never exist. Lifecycle, expiry and the confidential-model gate are in [pat-lifecycle.md](./pat-lifecycle.md).

## Anonymous sessions

The `anonymous` plugin is registered only when `AUTH_ALLOW_ANONYMOUS=true`; otherwise `/v1/api/auth/sign-in/anonymous` 404s, so a client bypassing the `VITE_AUTH_ENABLE_ANONYMOUS` overlay gains nothing. Two hardening choices are deliberate:

- The before-hook rejects `/sign-in/anonymous` when the caller already holds a non-anonymous session, so a real user cannot acquire an anonymous session that shadows their own (session fixation).
- `disableDeleteAnonymousUser: true` closes Better Auth's unauthenticated `/delete-anonymous-user` endpoint; the anonymous row is deleted from `onLinkAccount` instead, when the account is promoted.

Anonymous sign-in is intentionally _not_ waitlist-gated — trying the app without an account is the feature.

## Tests

`backend/src/auth/` carries the behavioural coverage worth reading before changing any of this: [`otp-security.test.ts`](../src/auth/otp-security.test.ts) (challenge binding, attempt counter, resend), [`waitlist-integration.test.ts`](../src/auth/waitlist-integration.test.ts), [`device-auth-apikey.test.ts`](../src/auth/device-auth-apikey.test.ts), [`sso-desktop-callback.test.ts`](../src/auth/sso-desktop-callback.test.ts), [`oidc-integration.test.ts`](../src/auth/oidc-integration.test.ts) and [`saml-integration.test.ts`](../src/auth/saml-integration.test.ts). Run them with `bun run test:backend`.
