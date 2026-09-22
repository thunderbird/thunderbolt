# Backend API Surface

The backend is a single Elysia application mounted with `prefix: '/v1'` (`backend/src/index.ts:66`). Every route group is a plugin `.use()`d onto that one app, so the `/v1` in a path comes from the mount, not from the plugin — a group that declares no prefix of its own lands directly under `/v1`.

This page is the inventory that the mount chain does not give you at a glance: for each prefix, who owns it, how a caller authenticates, which rate-limit tier it consumes, and whether it bypasses the minimum-app-version gate. Those last two are invisible in the route files themselves — the tier is threaded in from `backend/src/index.ts:90-198`, and the exemption lives in a list in a middleware — yet both are decisions you have to make every time you add a route.

## Global middleware, in order

The order in `backend/src/index.ts:112-205` is load-bearing:

1. `createCorsMiddleware` — first, so even short-circuited responses carry `Access-Control-Allow-Origin`.
2. `createLoggerMiddleware` and `createHttpLoggingMiddleware` — so a rejected request is still access-logged.
3. `createAppVersionMiddleware` — the 426 gate, after CORS and logging for the two reasons above.
4. `createErrorHandlingMiddleware` — the root `onError`. Elysia's plugin isolation keeps it from seeing errors thrown inside a plugin, so it only covers routes defined directly on the main app; that is why nearly every route module installs its own `.onError(safeErrorHandler)` (`backend/src/middleware/error-handling.ts:107-111`).
5. The Better Auth plugin, then the route groups.

Better Auth is mounted as a catch-all `plugin.all('/*', …)` (`backend/src/auth/elysia-plugin.ts:55`) rather than with Elysia's `mount()`, because `mount()` short-circuits the pipeline before `onBeforeHandle` and would silently bypass the IP rate limit wrapped around it. Better Auth's own `basePath: '/v1/api/auth'` (`backend/src/auth/auth.ts:156`) does the filtering; more specific routes registered later still win, so `/v1/config` resolves to the config route and only unclaimed `/v1/...` paths reach the auth handler.

## The inventory

Auth modes are described in the next section. "Gate" is whether the path sits under a prefix in `appVersionExemptPrefixes` (`backend/src/middleware/app-version.ts:16-25`) — `exempt` means the route is reachable without an `X-App-Version` header even when `MIN_APP_VERSION` is set.

| Path                                                                          | Module                                  | Auth                                      | Rate limit                                        | Gate    |
| ----------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- | ------------------------------------------------- | ------- |
| `ALL /v1/*` (Better Auth: `/v1/api/auth/*`)                                   | `auth/elysia-plugin.ts`, `auth/auth.ts` | the flow's own                            | `auth` (IP)                                       | gated\* |
| `GET /v1/api/auth/sso/desktop-initiate`, `/desktop-callback`                  | `auth/sso-desktop-callback.ts`          | browser redirect                          | —                                                 | exempt  |
| `GET /v1/health`                                                              | `api/routes.ts`                         | public                                    | —                                                 | exempt  |
| `GET /v1/health/{database,powersync,email,models}`                            | `api/health.ts`                         | `MONITORING_TOKEN`                        | —                                                 | exempt  |
| `GET /v1/config`                                                              | `api/config.ts`                         | public                                    | —                                                 | exempt  |
| `POST /v1/waitlist/join`                                                      | `waitlist/routes.ts`                    | public                                    | `auth` (IP) + 15s per-email cooldown              | gated   |
| `GET /v1/posthog/config`, `ALL /v1/posthog/*`                                 | `posthog/routes.ts`                     | public                                    | —                                                 | exempt  |
| `GET /v1/auth/oidc/config`                                                    | `auth/oidc.ts`                          | public                                    | —                                                 | gated   |
| `GET /v1/auth/{google,microsoft}/config`, `POST …/exchange`, `POST …/refresh` | `auth/google.ts`, `auth/microsoft.ts`   | session                                   | —                                                 | gated   |
| `GET /v1/locations`, `GET /v1/locations/:id`                                  | `api/routes.ts`                         | session                                   | —                                                 | gated   |
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
| `GET /v1/powersync/token`                                                     | `api/powersync.ts`                      | session, or signed bearer with no session | —                                                 | gated   |
| `PUT /v1/powersync/upload`                                                    | `api/powersync.ts`                      | session, non-anonymous                    | —                                                 | gated   |
| `POST`/`GET`/`DELETE` `/v1/devices/*`, `GET /v1/encryption/canary`            | `api/encryption.ts`                     | session                                   | —                                                 | gated   |
| `PUT /v1/account/devices/cli`, `POST /v1/account/devices/cli/logout`          | `api/account.ts`                        | signed bearer, verified inline            | —                                                 | gated   |
| `POST /v1/account/devices/:id/revoke`, `DELETE /v1/account`                   | `api/account.ts`                        | session (+ canary under E2EE)             | —                                                 | gated   |
| `GET /v1/agents`                                                              | `agents/routes.ts`                      | session, non-anonymous                    | —                                                 | gated   |
| `GET /v1/haystack/files/:fileId`                                              | `haystack/routes.ts`                    | session, non-anonymous                    | —                                                 | gated   |
| `WS /v1/haystack/ws`                                                          | `haystack/routes.ts`                    | subprotocol bearer                        | —                                                 | gated   |
| `GET /v1/swagger`, `/v1/swagger/json`                                         | `@elysiajs/swagger`, `SWAGGER_ENABLED`  | public                                    | —                                                 | gated   |

\* Two subtrees of the Better Auth surface are exempt: `/v1/api/auth/sso` (browser redirects) and `/v1/api/auth/device` (the headless CLI device grant). The rest of `/v1/api/auth/*` is gated.

† The `pro` limiter is mounted on the WebSocket plugin, but it keys on the `user` the auth macro resolves and the bearer is authorized inside `open()` instead, so the handshake itself is not user-limited. [rate-limiting.md](../../backend/docs/rate-limiting.md) spells this out.

Several groups are conditional and simply do not exist in some deployments: PowerSync routes return an empty plugin without `POWERSYNC_JWT_SECRET`, the SSO desktop callbacks mount only when `AUTH_MODE` is not `consumer`, `GET /v1/auth/oidc/config` only under `AUTH_MODE=oidc` with an `OIDC_ISSUER`, the transcript intake only under `DEBUG_TRANSCRIPT_INTAKE_ENABLED`, and the transcript relay degrades to a 403 stub when no upstream (`DEBUG_TRANSCRIPT_UPSTREAM_URL`) is configured. `PUT /v1/account/devices/cli` stays mounted but answers 404 unless `CLI_DEVICE_REGISTRATION_ENABLED` is set.

The table above was derived from Elysia's own router — `app.routes` on an app built by `createApp()` lists every mounted method and path, which is the fastest way to re-verify it after a change (see the pattern in `backend/src/index.test.ts`).

### Prefix quirks worth knowing

- The E2EE device routes are owned by `api/encryption.ts` but live at `/v1/devices/*`, while the CLI/revocation device routes are owned by `api/account.ts` at `/v1/account/devices/*`. Two modules, two prefixes, one word. The eleven encryption endpoints are enumerated with their canary requirements in [e2e-encryption.md](./e2e-encryption.md).
- The Anthropic-shaped managed endpoint really is `/v1/chat/v1/messages` — the inner `/v1` is part of the Messages API shape, not a mistake.
- `GET /v1/health` (public liveness, `api/routes.ts`) and `/v1/health/*` (token-gated probes, `api/health.ts`) are different modules sharing a prefix.
- Managed inference lives under `/v1/chat`, not `/v1/inference` — the only `/v1/inference-*` path is the usage receipt endpoint. There is no MCP-specific route either: remote MCP traffic rides the universal proxy like any other upstream (see [mcp-connections.md](./mcp-connections.md)).

## Auth modes

The session layer itself — which flows mint a session, how SSO and the CLI device grant differ, why bearer tokens must be signed — is covered in [backend/docs/authentication.md](../../backend/docs/authentication.md), and PAT creation and revocation in [pat-lifecycle.md](../../backend/docs/pat-lifecycle.md). What follows is only how a route consumes a credential.

**Session (`auth: true`).** The common case. `createAuthMacro` resolves a Better Auth session and 401s when there is none, putting a typed `user`/`session` on the context (`backend/src/auth/elysia-plugin.ts`). A session can come from a cookie, a signed bearer token, or — because the API-key plugin runs with `enableSessionForAPIKeys` — an `x-api-key` personal access token.

**Session via `.derive`.** `api/powersync.ts`, `agents/routes.ts` and `haystack/routes.ts` call `auth.api.getSession` in a `.derive` and branch themselves, because they need to distinguish "no session" from "anonymous session" and answer 401 vs 403 with a machine-readable `code`. Anonymous users are rejected from sync, agent discovery and Haystack files.

**Signed bearer verified inline.** `GET /v1/powersync/token` accepts a bearer with no session (credential refresh) and the CLI device routes verify the HMAC themselves via `verifySignedBearerToken` (`backend/src/auth/bearer-token.ts`). The bearer plugin runs with `requireSignature: true`, so any path that reads a raw `Authorization` header must re-verify the signature or it becomes a way to bypass it.

**WebSocket subprotocol bearer.** Browsers cannot set headers on `new WebSocket()`, so `/v1/proxy/ws` and `/v1/haystack/ws` carry the credential in a `thunderbolt.bearer.<token>` `Sec-WebSocket-Protocol` entry, validated in `open()` — not `beforeHandle`, which Bun's adapter may invoke more than once per upgrade. The bearer entry is deliberately not echoed back, so it never lands on `WebSocket.protocol` or in response logs.

**Operator token.** The deep health probes compare `Authorization` against `MONITORING_TOKEN` with `timingSafeEqual`, answering 403 when the token is unset and 401 when it does not match (`backend/src/api/health.ts:47-55`). See [self-hosting configuration](../self-hosting/configuration.md) for the env var.

**Server-to-server client key.** The transcript intake is authenticated by a per-client key, hashed and looked up in the database — never by a user session (`backend/src/api/debug-transcripts-intake.ts`).

Two extra guards layer on top of a session on the metered routes: `rejectPersonalAccessToken` returns 403 `WEB_LOGIN_REQUIRED` for `x-api-key` callers on the confidential routes unless `CONFIDENTIAL_API_KEYS_ENABLED` is set (the rationale is in `backend/src/inference/web-session.ts`), and `rejectUnregisteredCliDevice` returns 409 `CLI_DEVICE_NOT_BOUND` when a device-grant session is not bound to a live CLI device.

## Rate-limit tiers

Limits are hardcoded per tier in `backend/src/middleware/rate-limit.ts:33-40` and persisted through `rate-limiter-flexible`'s Drizzle store (`backend/src/db/rate-limit-schema.ts`), so they hold across instances:

| Tier                      | Budget       | Key                            |
| ------------------------- | ------------ | ------------------------------ |
| `inference`               | 60 / minute  | `user:<id>`                    |
| `receipt`                 | 100 / minute | `user:<id>`                    |
| `pro`                     | 100 / minute | `user:<id>`                    |
| `auth`                    | 10 / minute  | `ip:<addr>`                    |
| `debug-transcript`        | 10 / hour    | `user:<id>`                    |
| `debug-transcript-intake` | 600 / hour   | `ip:<addr>`, and `client:<id>` |

Three properties will bite you:

- **User-keyed limiters must be `.use()`d inside the `guard({ auth: true }, …)` callback.** They read the `user` the auth macro resolved; registered at app level the macro's resolve runs after `onBeforeHandle` and the limit becomes a silent no-op. Every call site follows this shape — copy it.
- **IP-keyed limiters fail closed.** An unresolvable client IP shares one `ip:unknown` bucket rather than skipping the check, so a control guarding OTP send and waitlist join cannot disable itself. The real client IP comes from `extractClientIp` and only trusts forwarding headers when `TRUSTED_PROXY` is configured.
- **`RATE_LIMIT_ENABLED=false` returns an empty plugin**, so the limiter disappears entirely rather than being bypassed per request.

Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a 429 adds `Retry-After`. [backend/docs/rate-limiting.md](../../backend/docs/rate-limiting.md) goes deeper on the mechanism and how to add a tier.

## Version gate and CORS

Both are explained in depth in [AGENTS.md](../../AGENTS.md) — "App version gate" and "CORS and API headers". The short version for route authors:

- The gate is **fail-closed**: a missing or unparseable `X-App-Version` is rejected on every non-exempt `/v1` path once `MIN_APP_VERSION` is set. `OPTIONS` preflights are always exempt, and prefix matching is on segment boundaries so `/v1/config` cannot exempt a future `/v1/configuration`.
- Anything reached by a browser redirect, a WebSocket upgrade, a header-less SDK (posthog-js) or a server-to-server caller needs a prefix in `appVersionExemptPrefixes`. Note that `/v1/haystack/ws` is not in that list today even though the managed-ACP client opens it as a native browser `WebSocket` (`src/acp/transports/index.ts`), which cannot attach the header — check this before enabling the gate.
- Request headers need no CORS change: both the main mount and the PostHog route use `allowedHeaders: true` and echo whatever the browser asks for. Response headers are the opposite — a browser can only read what `corsExposeHeaders` lists (`backend/src/config/settings.ts:11`), so a new protocol header on a response is invisible cross-origin until you add it there.

## Adding a route

1. **Pick the prefix.** Extend an existing group if the resource belongs to it; a new group is a new plugin `.use()`d in `backend/src/index.ts`. Give it its own `prefix:` unless you genuinely want to sit at the root of `/v1`.
2. **Install an error handler.** `.onError(safeErrorHandler)` on the plugin — the root middleware will not cover it.
3. **Choose the auth mode** from the list above. Prefer `guard({ auth: true }, …)`; reach for a `.derive` only when you need to answer differently for anonymous sessions. Decide explicitly whether anonymous users and `x-api-key` callers are allowed.
4. **Choose a rate-limit tier.** Reuse an existing one where it fits; a new tier means a new entry in `tierConfigs` and a `createUserTierRateLimit`/`createIpTierRateLimit` call threaded from `createApp`. Mount user-keyed limiters inside the guard.
5. **Decide the version-gate exemption.** If any caller cannot send `X-App-Version`, add the prefix to `appVersionExemptPrefixes`; otherwise leave it gated.
6. **Check response headers.** If cross-origin JavaScript must read a header you set, add it to `corsExposeHeaders`.
7. **Update this page**, and re-derive the table from `app.routes` rather than by hand.

## Related

- [E2E Encryption](./e2e-encryption.md) — what the `/v1/devices/*` and `/v1/encryption/*` routes actually do.
- [PowerSync, Accounts and Devices](./powersync-account-devices.md) — token issuance, device identity, the `x-device-id` contract.
- [Delete Account and Revoke Device](./delete-account-and-revoke-device.md) — the hard-delete paths under `/v1/account`.
- [Self-hosting configuration](../self-hosting/configuration.md) — every env var named above.
