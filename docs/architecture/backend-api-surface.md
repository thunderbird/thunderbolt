# Backend API Surface

One Elysia app, `prefix: '/v1'` (`backend/src/index.ts:66`). Route groups are plugins `.use()`d onto it; a group with no prefix of its own sits directly under `/v1`.

## Route inventory

**Gate**: path sits under a prefix in `appVersionExemptPrefixes` (`backend/src/middleware/app-version.ts:16-25`). `exempt` means reachable without `X-App-Version` under `MIN_APP_VERSION`. Auth modes: [below](#auth-modes).

| Path                                                                          | Module                                  | Auth                                      | Rate limit                                        | Gate    |
| ----------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- | ------------------------------------------------- | ------- |
| `ALL /v1/*` (Better Auth: `/v1/api/auth/*`)                                   | `auth/elysia-plugin.ts`, `auth/auth.ts` | the flow's own                            | `auth` (IP)                                       | gated\* |
| `GET /v1/api/auth/sso/desktop-initiate`, `/desktop-callback`                  | `auth/sso-desktop-callback.ts`          | browser redirect                          | none                                              | exempt  |
| `GET /v1/health`                                                              | `api/routes.ts`                         | public                                    | none                                              | exempt  |
| `GET /v1/health/{database,powersync,email,models}`                            | `api/health.ts`                         | `MONITORING_TOKEN`                        | none                                              | exempt  |
| `GET /v1/config`                                                              | `api/config.ts`                         | public                                    | none                                              | exempt  |
| `POST /v1/waitlist/join`                                                      | `waitlist/routes.ts`                    | public                                    | `auth` (IP) + 15s per-email cooldown              | gated   |
| `GET /v1/posthog/config`, `ALL /v1/posthog/*`                                 | `posthog/routes.ts`                     | public                                    | none                                              | exempt  |
| `GET /v1/auth/oidc/config`                                                    | `auth/oidc.ts`                          | public                                    | none                                              | gated   |
| `GET /v1/auth/{google,microsoft}/config`, `POST …/exchange`, `POST …/refresh` | `auth/google.ts`, `auth/microsoft.ts`   | session                                   | none                                              | gated   |
| `GET /v1/locations`, `GET /v1/locations/:id`                                  | `api/routes.ts`                         | session                                   | none                                              | gated   |
| `POST /v1/chat/completions`, `POST /v1/chat/v1/messages`                      | `inference/routes.ts`                   | session, CLI-device-checked               | `inference`                                       | gated   |
| `POST /v1/inference-usage/receipts`                                           | `inference/usage-receipt-routes.ts`     | session, web-only by default              | `receipt`                                         | gated   |
| `ALL /v1/tinfoil/*`                                                           | `tinfoil/routes.ts`                     | session, web-only by default              | `pro`                                             | gated   |
| `ALL /v1/proxy`                                                               | `proxy/routes.ts`                       | session                                   | `pro`                                             | gated   |
| `WS /v1/proxy/ws`                                                             | `proxy/ws.ts`                           | subprotocol bearer                        | `pro` mounted, but not enforcing†                 | exempt  |
| `GET /v1/search`                                                              | `api/search.ts`                         | session                                   | `pro`                                             | gated   |
| `POST /v1/preview`                                                            | `api/preview.ts`                        | session                                   | `pro`                                             | gated   |
| `POST /v1/pro/fetch-content`                                                  | `pro/routes.ts`, `pro/exa.ts`           | session                                   | `pro`                                             | gated   |
| `POST /v1/debug-transcripts`                                                  | `api/debug-transcripts.ts`              | session                                   | `debug-transcript`                                | gated   |
| `POST /v1/debug-transcripts/intake`                                           | `api/debug-transcripts-intake.ts`       | hashed client key                         | `debug-transcript-intake` (IP **and** per-client) | exempt  |
| `GET /v1/powersync/token`                                                     | `api/powersync.ts`                      | session, or signed bearer with no session | none                                              | gated   |
| `PUT /v1/powersync/upload`                                                    | `api/powersync.ts`                      | session, non-anonymous                    | none                                              | gated   |
| `POST`/`GET`/`DELETE` `/v1/devices/*`, `GET /v1/encryption/canary`            | `api/encryption.ts`                     | session                                   | none                                              | gated   |
| `PUT /v1/account/devices/cli`, `POST /v1/account/devices/cli/logout`          | `api/account.ts`                        | signed bearer, verified inline            | none                                              | gated   |
| `POST /v1/account/devices/:id/revoke`, `DELETE /v1/account`                   | `api/account.ts`                        | session (+ canary under E2EE)             | none                                              | gated   |
| `GET /v1/agents`                                                              | `agents/routes.ts`                      | session, non-anonymous                    | none                                              | gated   |
| `GET /v1/haystack/files/:fileId`                                              | `haystack/routes.ts`                    | session, non-anonymous                    | none                                              | gated   |
| `WS /v1/haystack/ws`                                                          | `haystack/routes.ts`                    | subprotocol bearer                        | none                                              | gated   |
| `GET /v1/swagger`, `/v1/swagger/json`                                         | `@elysiajs/swagger`, `SWAGGER_ENABLED`  | public                                    | none                                              | gated   |

\* Exempt subtrees: `/v1/api/auth/sso` (browser redirects) and `/v1/api/auth/device` (headless CLI device grant). The rest of `/v1/api/auth/*` is gated.

† The `pro` limiter is mounted on the WebSocket plugin but keys on the macro-resolved `user`, while the bearer is authorized in `open()`, so the handshake is not user-limited ([rate-limiting.md](../../backend/docs/rate-limiting.md)).

Re-derive from `app.routes` on a `createApp()` app (pattern: `backend/src/index.test.ts`).

### Conditional groups

| Group                         | Condition                                                           |
| ----------------------------- | ------------------------------------------------------------------- |
| PowerSync routes              | empty plugin without `POWERSYNC_JWT_SECRET`                         |
| SSO desktop callbacks         | mounted only when `AUTH_MODE` is not `consumer`                     |
| `GET /v1/auth/oidc/config`    | only under `AUTH_MODE=oidc` with an `OIDC_ISSUER`                   |
| Transcript intake             | only under `DEBUG_TRANSCRIPT_INTAKE_ENABLED`                        |
| Transcript relay              | 403 stub when `DEBUG_TRANSCRIPT_UPSTREAM_URL` is unset              |
| `PUT /v1/account/devices/cli` | stays mounted, answers 404 unless `CLI_DEVICE_REGISTRATION_ENABLED` |

### Prefix quirks

- `/v1/devices/*` belongs to `api/encryption.ts`, `/v1/account/devices/*` (CLI, revocation) to `api/account.ts`. Eleven encryption endpoints and their canary rules: [e2e-encryption.md](./e2e-encryption.md).
- `/v1/chat/v1/messages`: the inner `/v1` is part of the Anthropic Messages API shape.
- `GET /v1/health` (public liveness, `api/routes.ts`) and `/v1/health/*` (token-gated probes, `api/health.ts`) are different modules on one prefix.
- Managed inference is under `/v1/chat`, not `/v1/inference`; the only `/v1/inference-*` path is the usage receipt.
- No MCP route: remote MCP rides the universal proxy ([mcp-connections.md](./mcp-connections.md)).

## Global middleware, in order

Order in `backend/src/index.ts:112-205` is load-bearing:

1. `createCorsMiddleware`: short-circuited responses still carry `Access-Control-Allow-Origin`.
2. `createLoggerMiddleware` and `createHttpLoggingMiddleware`: rejected requests are still access-logged.
3. `createAppVersionMiddleware`: the 426 gate, after CORS and logging for those two reasons.
4. `createErrorHandlingMiddleware`: the root `onError`.
5. The Better Auth plugin, then the route groups.

Plugin isolation hides in-plugin errors from the root `onError`, which covers only routes on the main app. Nearly every route module installs its own `.onError(safeErrorHandler)` (`backend/src/middleware/error-handling.ts:107-111`).

### Why Better Auth is a catch-all, not a `mount()`

`mount()` short-circuits before `onBeforeHandle`, silently bypassing the IP rate limit wrapped around it. So Better Auth is `plugin.all('/*', …)` (`backend/src/auth/elysia-plugin.ts:55`), filtered by its own `basePath: '/v1/api/auth'` (`backend/src/auth/auth.ts:156`); later, more specific routes win, so `/v1/config` resolves to the config route and only unclaimed `/v1/...` paths reach it.

## Auth modes

Session minting, SSO, the CLI device grant, bearer signing: [backend/docs/authentication.md](../../backend/docs/authentication.md). PAT lifecycle: [pat-lifecycle.md](../../backend/docs/pat-lifecycle.md).

| Mode                           | How it is checked                                                                                                                                             | Used by                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Session (`auth: true`)         | `createAuthMacro` resolves a Better Auth session, 401s when there is none, puts a typed `user`/`session` on the context (`backend/src/auth/elysia-plugin.ts`) | the common case                                              |
| Session via `.derive`          | `auth.api.getSession` called directly, route branches itself                                                                                                  | `api/powersync.ts`, `agents/routes.ts`, `haystack/routes.ts` |
| Signed bearer, verified inline | the route verifies the HMAC itself via `verifySignedBearerToken` (`backend/src/auth/bearer-token.ts`)                                                         | `GET /v1/powersync/token`, the CLI device routes             |
| WebSocket subprotocol bearer   | `thunderbolt.bearer.<token>` entry in `Sec-WebSocket-Protocol`, validated in `open()`                                                                         | `/v1/proxy/ws`, `/v1/haystack/ws`                            |
| Operator token                 | `Authorization` compared against `MONITORING_TOKEN` with `timingSafeEqual` (`backend/src/api/health.ts:47-55`)                                                | the deep health probes                                       |
| Server-to-server client key    | per-client key, hashed and looked up in the database, never a user session (`backend/src/api/debug-transcripts-intake.ts`)                                    | the transcript intake                                        |

- Sessions come from a cookie, a signed bearer, or an `x-api-key` PAT (`enableSessionForAPIKeys`).
- `.derive` routes branch to answer 401 (no session) vs 403 (anonymous) with a machine-readable `code`. Anonymous users are rejected from sync, agent discovery and Haystack files.
- `GET /v1/powersync/token` accepts a bearer with no session (credential refresh). The bearer plugin runs `requireSignature: true`, so any path reading a raw `Authorization` header must re-verify the signature or become a bypass.
- Browsers cannot set headers on `new WebSocket()`, hence the subprotocol. Validation runs in `open()`, not `beforeHandle`, which Bun's adapter may invoke more than once per upgrade. The bearer entry is never echoed back, keeping it out of `WebSocket.protocol` and response logs.
- Health probes answer 403 when `MONITORING_TOKEN` is unset, 401 when it does not match ([self-hosting configuration](../self-hosting/configuration.md)).

Metered routes add two guards:

- `rejectPersonalAccessToken`: 403 `WEB_LOGIN_REQUIRED` for `x-api-key` callers on the confidential routes unless `CONFIDENTIAL_API_KEYS_ENABLED` is set (rationale in `backend/src/inference/web-session.ts`).
- `rejectUnregisteredCliDevice`: 409 `CLI_DEVICE_NOT_BOUND` when a device-grant session is not bound to a live CLI device.

## Rate-limit tiers

| Tier                      | Budget       | Key                            |
| ------------------------- | ------------ | ------------------------------ |
| `inference`               | 60 / minute  | `user:<id>`                    |
| `receipt`                 | 100 / minute | `user:<id>`                    |
| `pro`                     | 100 / minute | `user:<id>`                    |
| `auth`                    | 10 / minute  | `ip:<addr>`                    |
| `debug-transcript`        | 10 / hour    | `user:<id>`                    |
| `debug-transcript-intake` | 600 / hour   | `ip:<addr>`, and `client:<id>` |

Limits are hardcoded per tier in `backend/src/middleware/rate-limit.ts:33-40`, threaded into route groups from `backend/src/index.ts:90-198`, and persisted through `rate-limiter-flexible`'s Drizzle store (`backend/src/db/rate-limit-schema.ts`), so they hold across instances.

- **User-keyed limiters go inside the `guard({ auth: true }, …)` callback.** They read the macro-resolved `user`; at app level the resolve runs after `onBeforeHandle` and the limit is a silent no-op.
- **IP-keyed limiters fail closed.** An unresolvable IP shares one `ip:unknown` bucket instead of skipping the check, so the guard on OTP send and waitlist join cannot disable itself. `extractClientIp` trusts forwarding headers only under `TRUSTED_PROXY`.
- **`RATE_LIMIT_ENABLED=false` returns an empty plugin**: the limiter disappears rather than being bypassed per request.

Limited responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a 429 adds `Retry-After`. Mechanism and how to add a tier: [backend/docs/rate-limiting.md](../../backend/docs/rate-limiting.md).

## Version gate and CORS

Full treatment in [AGENTS.md](../../AGENTS.md), "App version gate" and "CORS and API headers":

- **Fail-closed**: a missing or unparseable `X-App-Version` is rejected on every non-exempt `/v1` path once `MIN_APP_VERSION` is set. `OPTIONS` preflights are always exempt; prefix matching is on segment boundaries, so `/v1/config` cannot exempt a future `/v1/configuration`.
- Browser redirects, WebSocket upgrades, header-less SDKs (posthog-js) and server-to-server callers need a prefix in `appVersionExemptPrefixes`. `/v1/haystack/ws` is not listed today, though the managed-ACP client opens it as a native browser `WebSocket` (`src/acp/transports/index.ts`) that cannot attach the header. Check before enabling the gate.
- Request headers need no CORS change: the main mount and the PostHog route use `allowedHeaders: true`, echoing back whatever the browser asks for. Response headers are the opposite, cross-origin JS reads only what `corsExposeHeaders` lists (`backend/src/config/settings.ts:11`).

## Adding a route

1. **Pick the prefix.** Extend an existing group, or `.use()` a new plugin in `backend/src/index.ts` with its own `prefix:` (omit only to sit at the root of `/v1`).
2. **Install an error handler.** `.onError(safeErrorHandler)` on the plugin; the root one will not cover it.
3. **Choose the auth mode** from the table above. Prefer `guard({ auth: true }, …)`; use `.derive` only when anonymous sessions need a different answer. Decide whether anonymous and `x-api-key` callers are allowed.
4. **Choose a rate-limit tier.** A new tier needs a `tierConfigs` entry and a `createUserTierRateLimit`/`createIpTierRateLimit` call threaded from `createApp`. Mount user-keyed limiters inside the guard.
5. **Decide the version-gate exemption.** Add the prefix to `appVersionExemptPrefixes` if any caller cannot send `X-App-Version`.
6. **Check response headers.** Any header cross-origin JavaScript must read goes in `corsExposeHeaders`.
7. **Update this page**, re-deriving the table from `app.routes`.

## Related

- [E2E Encryption](./e2e-encryption.md): what the `/v1/devices/*` and `/v1/encryption/*` routes do.
- [PowerSync, Accounts and Devices](./powersync-account-devices.md): token issuance, device identity, the `x-device-id` contract.
- [Delete Account and Revoke Device](./delete-account-and-revoke-device.md): the hard-delete paths under `/v1/account`.
- [Self-hosting configuration](../self-hosting/configuration.md): every env var named above.
