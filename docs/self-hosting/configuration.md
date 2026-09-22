# Configuration

Thunderbolt's backend is configured through environment variables. The schema lives at [backend/src/config/settings.ts](../../backend/src/config/settings.ts) and is validated with Zod on startup — misconfiguration fails loud, not silent.

Copy the example to a `.env` file and customize:

```bash
cp backend/.env.example backend/.env
```

Variables marked **required** must be set before the backend will start.

## Database

| Variable             | Default                                                       | Required | Description                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | dev: `postgresql://postgres:postgres@localhost:5433/postgres` | **yes**  | Postgres connection string. Outside `NODE_ENV=development` the backend throws at import when it is unset and the driver is `postgres`.                                                                 |
| `DATABASE_DRIVER`    | `postgres`                                                    |          | Set to `pglite` to run an embedded Postgres for backend-only work without Docker. PowerSync cannot replicate from PGlite, so sync is off.                                                              |
| `SKIP_MIGRATIONS`    | unset                                                         |          | `true` skips the startup migration run, for deployments that migrate out of band.                                                                                                                      |
| `MIGRATIONS_DIR`     | `<cwd>/drizzle`                                               |          | Override the Drizzle migrations folder.                                                                                                                                                                |
| `POSTGRES_ADMIN_URL` | —                                                             |          | Read by `deploy/docker/backend-entrypoint.sh`, not the backend. When set, the entrypoint creates the logical database named in `DATABASE_URL` before migrating — the shared-Postgres PR-preview model. |

Under `DATABASE_DRIVER=pglite`, `DATABASE_URL` is read as a _data directory path_ rather than a connection string (`backend/.env.example` uses `.pglite/data`). A value that still looks like a connection string is detected and ignored, with PGlite falling back to in-memory and logging a warning — otherwise an inherited `postgresql://…` would be treated as a path and bootstrap a data directory inside `backend/`. See [backend/src/db/client.ts](../../backend/src/db/client.ts).

## Authentication

| Variable                     | Default                                           | Required | Description                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_MODE`                  | `consumer`                                        |          | `consumer` for magic-link + Google/Microsoft OAuth, `oidc` for OIDC SSO, `saml` for SAML SSO                                                                                                                             |
| `AUTH_ALLOW_ANONYMOUS`       | `false`                                           |          | Registers Better Auth's anonymous plugin. Off by default, so `/v1/api/auth/sign-in/anonymous` returns 404 — pair it with the frontend `VITE_AUTH_ENABLE_ANONYMOUS` overlay or the UI offers a route the server rejects   |
| `BETTER_AUTH_SECRET`         | —                                                 | **yes**  | Non-empty string used to sign sessions. Generate with `openssl rand -hex 32`.                                                                                                                                            |
| `BETTER_AUTH_URL`            | `http://localhost:8000`                           |          | Public URL the backend is served at; used in OAuth redirects                                                                                                                                                             |
| `TRUSTED_ORIGINS`            | `http://localhost:1420,tauri://localhost`         |          | Comma-separated origins Better Auth accepts for callbacks and SSO discovery/metadata. Read straight from `process.env`, outside the Zod schema; `tauri://localhost` and the `BETTER_AUTH_URL` origin are always appended |
| `GOOGLE_CLIENT_ID`           | —                                                 |          | Google OAuth client ID (consumer mode)                                                                                                                                                                                   |
| `GOOGLE_CLIENT_SECRET`       | —                                                 |          | Google OAuth client secret                                                                                                                                                                                               |
| `MICROSOFT_CLIENT_ID`        | —                                                 |          | Microsoft OAuth client ID                                                                                                                                                                                                |
| `MICROSOFT_CLIENT_SECRET`    | —                                                 |          | Microsoft OAuth client secret                                                                                                                                                                                            |
| `OIDC_ISSUER`                | —                                                 |          | OIDC issuer URL (required when `AUTH_MODE=oidc`)                                                                                                                                                                         |
| `OIDC_DISCOVERY_URL`         | `${OIDC_ISSUER}/.well-known/openid-configuration` |          | Optional override for the OIDC discovery endpoint. Use when backend reaches the IdP at an internal hostname (e.g. `http://keycloak:8080/...`) but tokens are issued with a browser-facing hostname                       |
| `OIDC_CLIENT_ID`             | —                                                 |          | OIDC client ID                                                                                                                                                                                                           |
| `OIDC_CLIENT_SECRET`         | —                                                 |          | OIDC client secret                                                                                                                                                                                                       |
| `SAML_ENTRY_POINT`           | —                                                 |          | SAML IdP SSO URL (required when `AUTH_MODE=saml`)                                                                                                                                                                        |
| `SAML_ENTITY_ID`             | —                                                 |          | SP entity ID — must match the SAML client ID in the IdP (e.g. `thunderbolt-saml-sp`)                                                                                                                                     |
| `SAML_IDP_ISSUER`            | —                                                 |          | IdP entity ID / issuer (e.g. `https://keycloak.example.com/realms/thunderbolt`)                                                                                                                                          |
| `SAML_CERT`                  | —                                                 |          | SAML IdP signing certificate (base64, no PEM headers)                                                                                                                                                                    |
| `DEVICE_AUTH_EXPIRES_IN`     | `30m`                                             |          | How long a device/user code from the RFC 8628 grant (used by the `thunderbolt` CLI) stays valid. Better Auth time string                                                                                                 |
| `DEVICE_AUTH_INTERVAL`       | `5s`                                              |          | Minimum polling gap the device grant asks clients to respect                                                                                                                                                             |
| `API_KEY_DEFAULT_EXPIRES_IN` | `7776000`                                         |          | Default personal-access-token lifetime, in seconds (90 days). Callers may request another supported lifetime at creation                                                                                                 |

Consumer mode uses [Better Auth](https://better-auth.com)'s magic-link flow by default (email-delivered OTP). Hook up a provider by also setting the OAuth credentials above. Enterprise mode delegates entirely to an OIDC or SAML identity provider (Keycloak by default). See [OIDC local dev](../../backend/docs/oidc-local-dev.md) and [SAML local dev](../../backend/docs/saml-local-dev.md) for setup guides.

**Important:** When using `AUTH_MODE=oidc` or `saml`, the IdP origin must be included in `TRUSTED_ORIGINS` (the row above — this is a Better Auth setting, distinct from `CORS_ORIGINS`). The SSO plugin validates discovery/metadata URLs against this list. A containerized deploy needs _both_ hostnames: the browser-facing issuer origin and the internal discovery host. `deploy/docker-compose.yml` is the worked example, setting `TRUSTED_ORIGINS` to the app origin plus `http://localhost:${KEYCLOAK_PORT}` plus `http://keycloak:8080`.

### Desktop OAuth redirect URIs

The desktop app does not use the web redirect. It starts a loopback HTTP server and binds the first free port out of `17421`, `17422`, `17423` (`src-tauri/src/commands.rs`), so all three must be registered as redirect URIs in your Google and Microsoft OAuth consoles. There is deliberately no fallback to a random port — providers reject a redirect URI on an unregistered port, so `bind_to_port` in `src-tauri/src/oauth_server.rs` errors out instead of failing at the provider with a confusing message. Registering only the web redirect gives desktop users a hard sign-in failure.

## AI Provider Keys

Set any subset; the app exposes each provider whose key is present.

| Variable              | Default                           | Description                                                                                      |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`   | —                                 | Anthropic (Claude)                                                                               |
| `FIREWORKS_API_KEY`   | —                                 | Fireworks                                                                                        |
| `EXA_API_KEY`         | —                                 | Exa search (for web-grounded retrieval)                                                          |
| `TINFOIL_API_KEY`     | —                                 | Tinfoil, the confidential (attested enclave) tier                                                |
| `TINFOIL_ENCLAVE_URL` | `https://inference.tinfoil.sh/v1` | Enclave base URL. Include the `/v1` prefix — Tinfoil's OpenAI-compatible endpoints live under it |

The provider base URLs are otherwise fixed in `backend/src/inference/client.ts`; there is no backend variable for an OpenAI-compatible endpoint of your own. User-level keys (OpenAI, OpenRouter, and so on) are configured in the app, not as backend env vars, and the app's Add Model form has a `custom` provider whose URL field is where a local Ollama or llama.cpp server goes — it prefills `http://localhost:11434/v1`.

### Managed inference quotas

Managed inference is metered against rolling spend windows, in integer cents. Anonymous sessions get a much smaller allowance than registered accounts because an anonymous session costs an attacker nothing to create.

| Variable                              | Default |
| ------------------------------------- | ------- |
| `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`  | `10`    |
| `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`  | `60`    |
| `INFERENCE_QUOTA_REGISTERED_5H_CENTS` | `1500`  |
| `INFERENCE_QUOTA_REGISTERED_7D_CENTS` | `7500`  |

Each must be a positive integer; the ledger that spends against them is `backend/src/inference/usage-ledger.ts`.

## Agents

| Variable                 | Default | Description                                                                                                                             |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLED_AGENTS`         | `""`    | Comma-separated agent IDs `GET /v1/agents` may expose. Empty means no filter — every registered provider is listed                      |
| `ALLOW_CUSTOM_AGENTS`    | `true`  | `false` makes the discovery response report `allowCustomAgents: false` and the UI hides "Add Custom Agent"                              |
| `DISABLE_BUILT_IN_AGENT` | `false` | `true` omits the built-in Thunderbolt agent from the client's agent list entirely, for deployments shipping only their own agents       |
| `HAYSTACK_BASE_URL`      | —       | Deepset/Haystack API base URL                                                                                                           |
| `HAYSTACK_API_KEY`       | —       | Deepset/Haystack API key                                                                                                                |
| `HAYSTACK_WORKSPACE`     | —       | Deepset workspace slug; request URLs are `${base}/api/v1/workspaces/${workspace}/...`                                                   |
| `HAYSTACK_PIPELINES`     | —       | JSON array of pipeline descriptors: `[{id, name, pipelineName, pipelineId, description?, icon?, supportedContent?}]`, validated on read |

## PowerSync

| Variable                         | Default | Required         | Description                                                               |
| -------------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `POWERSYNC_URL`                  | —       | yes (for sync)   | URL of the PowerSync service (e.g. `http://localhost:8080` for local dev) |
| `POWERSYNC_JWT_SECRET`           | —       | yes when URL set | HS256 secret shared with PowerSync; must be **≥ 32 characters**           |
| `POWERSYNC_JWT_KID`              | —       |                  | Key ID for PowerSync to pick among multiple secrets during rotation       |
| `POWERSYNC_TOKEN_EXPIRY_SECONDS` | `3600`  |                  | PowerSync JWT lifetime                                                    |

The JWT secret must match the `k` value the PowerSync service loads at runtime. For self-hosted deploys, `deploy/config/powersync-config.yaml` reads it from the `PS_JWT_KEY_BASE64` env var (base64 of the raw secret); `POWERSYNC_JWT_KID` on the backend must match `PS_JWT_KID` set on the PowerSync service. For local dev, both values are baked into `powersync-service/config/config.yaml`.

## End-to-End Encryption

| Variable       | Default | Description                                                                                                                                     |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2EE_ENABLED` | `false` | Requires each device to complete the trust flow before it may sync, and turns on client-side encryption of the columns in `encryptedColumnsMap` |

The backend is the only source of truth for this — the frontend reads it from `GET /v1/config`, so there is no matching frontend variable. See [E2E encryption](../architecture/e2e-encryption.md) for the key hierarchy, the device-approval flows, and which columns are covered.

## CORS

| Variable                 | Default                                                          | Description                                                                              |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`           | `http://localhost:1420,tauri://localhost,http://tauri.localhost` | Exact-match allowed origins (comma-separated)                                            |
| `CORS_ALLOW_CREDENTIALS` | `true`                                                           | Whether browsers may send cookies                                                        |
| `CORS_ALLOW_METHODS`     | `GET,POST,PUT,DELETE,PATCH,OPTIONS`                              | Allowed HTTP methods                                                                     |
| `CORS_ALLOW_HEADERS`     | `""`                                                             | Legacy, unused. No production mount reads it; kept for backward compat and test fixtures |
| `CORS_EXPOSE_HEADERS`    | _(see [settings.ts](../../backend/src/config/settings.ts))_      | Response headers the browser makes readable to client code                               |

Request headers need no configuration. Both mounts — the main backend ([backend/src/config/cors.ts](../../backend/src/config/cors.ts)) and the PostHog proxy ([backend/src/posthog/routes.ts](../../backend/src/posthog/routes.ts)) — pass `allowedHeaders: true`, which echoes back whatever the browser asked for in `Access-Control-Request-Headers`. That is required by the universal proxy at `/v1/proxy`, which forwards arbitrary upstream headers as `X-Proxy-Passthrough-*`: a static allowlist would break preflight every time a new provider header appeared. So adding a new `X-*` header to a client request is not a CORS change.

The reverse is not true. A browser can only read a _response_ header that is named in `CORS_EXPOSE_HEADERS`, so anything cross-origin client code needs to inspect must be added there.

## Analytics

| Variable          | Default                    | Description                                  |
| ----------------- | -------------------------- | -------------------------------------------- |
| `POSTHOG_HOST`    | `https://us.i.posthog.com` | PostHog instance hostname                    |
| `POSTHOG_API_KEY` | —                          | Leave unset to disable server-side analytics |

See [TELEMETRY.md](../../TELEMETRY.md) in the repo for the full list of events the client emits.

## Debug Transcripts

Users can share a chat's debug transcript with the Thunderbolt team from the chat view. The deployment never stores transcripts; it forwards them to the Thunderbolt intake with a key that identifies your deployment. The button is shown only when the relay is configured.

| Variable                          | Default | Description                                                                           |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `DEBUG_TRANSCRIPT_UPSTREAM_URL`   | empty   | Base URL of the Thunderbolt API that receives transcripts. Set together with the key. |
| `DEBUG_TRANSCRIPT_UPSTREAM_KEY`   | empty   | Your deployment's client key, issued by the Thunderbolt team. Keep it server-side.    |
| `DEBUG_TRANSCRIPT_INTAKE_ENABLED` | `false` | Mounts the intake endpoint. Only the Thunderbolt-hosted deployment enables this.      |

To obtain a key, contact the Thunderbolt team with a name for your deployment. Transcripts are identified (user id and email as known by your deployment; blank for anonymous users) and are kept by the Thunderbolt team; deleting the submitting account does not remove them.

## Rate Limiting and Proxy Trust

| Variable             | Default | Description                                                                                               |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `true`  | Set to `false` to disable rate limiting (local dev only)                                                  |
| `TRUSTED_PROXY`      | `""`    | `cloudflare` trusts `CF-Connecting-IP`, `akamai` trusts `True-Client-IP`, empty trusts only the socket IP |

Trusting the wrong proxy header lets a client spoof its IP for rate-limit bypass. Leave this empty unless you know your edge.

The limits themselves are not configurable — they are hardcoded per tier in [backend/src/middleware/rate-limit.ts](../../backend/src/middleware/rate-limit.ts):

| Tier                      | Limit          |
| ------------------------- | -------------- |
| `inference`               | 60 per minute  |
| `receipt`                 | 100 per minute |
| `pro`                     | 100 per minute |
| `auth`                    | 10 per minute  |
| `debug-transcript`        | 10 per hour    |
| `debug-transcript-intake` | 600 per hour   |

Authenticated routes are keyed on `user:<id>`; unauthenticated ones on the client IP. IP keying fails **closed**: traffic whose IP cannot be resolved shares one `ip:unknown` bucket rather than skipping the limit, so the control guarding the abuse-prone unauthenticated endpoints (OTP send, waitlist join) cannot silently disable itself. Identifiable clients keep their own bucket and are unaffected.

Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a rejection is `429` with `Retry-After`. None of those are in the default `CORS_EXPOSE_HEADERS`, so cross-origin client code cannot read them unless you add them.

Rate limiting is also forced off in the backend test preload (`backend/src/test-utils/test-setup.ts`), because the limiter's own transactions bypass PGlite's test isolation and break cleanup. The middleware itself is still covered: `backend/src/middleware/rate-limit.test.ts` builds limiters with `enabled: true` against a separate isolated PGlite connection.

## App Version Gate

| Variable          | Default | Description                                                                                                                                                                                                                                                       |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_APP_VERSION` | `""`    | Minimum client version (semver). Empty disables the gate. When set, requests from older clients get `426 Upgrade Required`, except on the exempt prefixes below. The value is semver-validated at startup, so a typo fails fast instead of reaching every client. |

The gate **fails closed**: a request with no `X-App-Version` header, or an unparseable one, is rejected exactly like an outdated client. Only the prefixes in `appVersionExemptPrefixes` ([backend/src/middleware/app-version.ts](../../backend/src/middleware/app-version.ts)) are waved through, because their callers cannot attach the header — `/v1/config`, `/v1/health`, `/static`, `/v1/api/auth/sso`, `/v1/api/auth/device`, `/v1/posthog`, `/v1/proxy/ws` (browsers cannot set headers on a WebSocket handshake) and `/v1/debug-transcripts/intake` (server-to-server). `OPTIONS` preflights are always exempt. Matching is on segment boundaries, so `/v1/config` never exempts a future `/v1/configuration`.

Non-browser API-key clients are not exempt by auth scheme: a personal access token hitting a gated route must send `X-App-Version` once you enable this.

Settings are read once at startup, so **restart the backend** after changing `MIN_APP_VERSION` — it is not picked up live.

## CLI Device Rollout

| Variable                          | Default | Description                                                                             |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `MIN_APP_VERSION`                 | `""`    | Minimum compatible app semver; empty disables client blocking                           |
| `CLI_DEVICE_REGISTRATION_ENABLED` | `false` | Enables server-owned CLI device registration when set to `true`                         |
| `CONFIDENTIAL_API_KEYS_ENABLED`   | `false` | Lets a personal access token reach the confidential (Tinfoil) routes when set to `true` |

Rollout has three mandatory, old-client-safe stages:

1. **Existing clients first:** ship web, desktop, and mobile schema/UI support
   that can safely parse and display `deviceType: cli`. If the compatible
   installed base cannot be guaranteed, enforce a minimum-version gate before
   enabling CLI registration on the backend.
2. **Backend second:** deploy the public catalog, CLI registration/logout,
   revocation enforcement, and managed inference routes. Changes to shared
   default-model or usage-receipt inputs must rebuild the backend
   image.
3. **CLI last:** publish the native CLI artifacts only after the compatible
   existing clients and backend are live.

This remains backend-first relative to the CLI binary while preventing an older
web, desktop, or mobile client from receiving a device type its schema or UI
cannot handle. It also prevents a new CLI from discovering a catalog whose
required auth or inference contracts the deployed backend does not yet
implement.

## Waitlist

| Variable                        | Default | Description                                                                                   |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `WAITLIST_ENABLED`              | `false` | **Inert.** Parsed and validated, but nothing reads it — see below                             |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | —       | Comma-separated email domains that skip the queue; a matching address is approved on the spot |

`WAITLIST_ENABLED` does not switch the waitlist on or off. The gate in [backend/src/auth/auth.ts](../../backend/src/auth/auth.ts) runs unconditionally on the email-OTP path: an address with no `user` row and no approved waitlist entry gets a "joined" or "not ready" email instead of a code, and is rejected again at sign-in. `settings.waitlistEnabled` has no reader outside test fixtures. Several deployment configs still set it; the value has no effect either way.

`WAITLIST_AUTO_APPROVE_DOMAINS` is therefore the real escape hatch for a self-hosted consumer-mode deployment. On the client side the modal can be skipped at build time with `VITE_BYPASS_WAITLIST=true` (`src/lib/auth-mode.ts`), but that is a UI bypass baked into the bundle — the backend still gates the sign-in.

## OpenTelemetry (Optional)

OpenTelemetry traces are enabled automatically when these are set. Not part of the Zod schema — the backend reads them from `process.env` directly.

| Variable                      | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TOKEN`    | Bearer token for authenticated collectors                   |

Tested with BetterStack, Jaeger, Zipkin, New Relic, Grafana Cloud, and any OTLP-compatible collector.

## General

| Variable                    | Default                                        | Description                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | `8000`                                         | HTTP port the backend listens on                                                                                                                                                                                                                                |
| `HOST`                      | `0.0.0.0` in production, `localhost` otherwise | Interface the backend binds to                                                                                                                                                                                                                                  |
| `WEB_CONCURRENCY`           | CPU count in production, `1` otherwise         | Worker processes forked by `backend/src/cluster.ts`                                                                                                                                                                                                             |
| `APP_URL`                   | `http://localhost:1420`                        | Public URL where the frontend is served                                                                                                                                                                                                                         |
| `LOG_LEVEL`                 | `INFO`                                         | One of `DEBUG`, `INFO`, `WARN`, `ERROR`                                                                                                                                                                                                                         |
| `SWAGGER_ENABLED`           | `false`                                        | Expose `/v1/swagger` with the full OpenAPI spec (don't in production)                                                                                                                                                                                           |
| `MONITORING_TOKEN`          | —                                              | Bearer token for deep health routes under `/v1/health/`                                                                                                                                                                                                         |
| `RESEND_API_KEY`            | —                                              | Resend key used to send transactional email (sign-in codes, waitlist). Unset logs a warning at boot and skips sends, which is the usual local-dev setup — but under `NODE_ENV=production` an unset key makes the send path throw `Email service not configured` |
| `RESEND_MONITORING_API_KEY` | —                                              | Full access Resend key used only by `/v1/health/email`; the sending key `RESEND_API_KEY` may stay sending-only                                                                                                                                                  |

### Deep health

Send `Authorization: Bearer <MONITORING_TOKEN>` to these GET routes:

| Route                  | Dependency exercised                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/v1/health/database`  | A trivial database query (5-second deadline)                                                                 |
| `/v1/health/powersync` | PowerSync's `/probes/liveness` endpoint (5 seconds)                                                          |
| `/v1/health/email`     | Resend's authenticated domains read (10 seconds; sends no email)                                             |
| `/v1/health/models`    | Every catalog model, including attested, encrypted Tinfoil completions (20 seconds per model, concurrency 3) |

Success returns `200 {"status":"ok"}`. Dependency failure returns `503 {"status":"failed","reason":"<code>"}`; the models route instead returns `{"status":"failed","failures":[{"model":"<catalog model>","reason":"no-text"}]}`. Model failure reasons are `no-text`, `timeout`, `upstream-error`, `missing-price`, or `not-configured`; reasons never contain upstream bodies or credentials.

An unset token returns `403 {"error":"Monitoring token not configured"}`; a missing or incorrect bearer returns `401 {"error":"Unauthorized"}`. Rejected calls run no probes. The unconditional, unauthenticated `/v1/health` remains available for load balancers and liveness probes.

The email probe uses a separate Resend Full access key in `RESEND_MONITORING_API_KEY` to read the domain list and requires the sending domain from `emailFrom` to be verified. The sending key `RESEND_API_KEY` may stay sending-only. A missing monitoring key returns `503` with reason `not-configured`; an invalid, sending-only, or forbidden monitoring key returns `rejected` (upstream HTTP 400/401/403); a missing or unverified sending domain, including a malformed response, returns `domain-unverified`. Missing PowerSync configuration also returns `503` with reason `not-configured`.

Each models call costs one tiny completion per catalog model with a price row, without retries. BetterStack polls this route every 15 minutes in production.

## The `GET /v1/config` Boot Contract

Several of the variables above are not read by the backend alone — they are published unauthenticated at `GET /v1/config`, which every client fetches at boot and caches in `localStorage` so it keeps working offline. The full payload ([backend/src/api/config.ts](../../backend/src/api/config.ts)):

| Field                     | Source                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `e2eeEnabled`             | `E2EE_ENABLED`                                                                                                       |
| `debugTranscriptsEnabled` | Derived: true when `DEBUG_TRANSCRIPT_UPSTREAM_URL` is set                                                            |
| `builtInAgentEnabled`     | Inverse of `DISABLE_BUILT_IN_AGENT` — the env var reads as an opt-in switch, the wire field as a positive capability |
| `allowCustomAgents`       | `ALLOW_CUSTOM_AGENTS`                                                                                                |
| `minAppVersion`           | `MIN_APP_VERSION`, **omitted** when unset so the client never parses `''` as semver                                  |
| `defaults.models`         | `{ version, defaultModelId, data }` from the shipped default model set                                               |

`defaults` is an over-the-air channel: the client compares the server's version against its own bundled copy, so a change to the shipped defaults reaches existing installs without a client release. Because the payload is baked into the backend image, changing it means rebuilding and redeploying the backend.

## Frontend Build Args

`deploy/docker/frontend.Dockerfile` exposes two Vite env vars as build args:

| Arg                          | Default | Purpose                                                                |
| ---------------------------- | ------- | ---------------------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Backend API URL (relative path, proxied by nginx or ALB)               |
| `VITE_AUTH_MODE`             | `sso`   | Auth mode — `sso` for enterprise SSO (OIDC or SAML), omit for consumer |

Two further Vite variables are read by the app but are not wired as Dockerfile build args, so a custom build must pass them itself: `VITE_AUTH_ENABLE_ANONYMOUS` (the client half of `AUTH_ALLOW_ANONYMOUS`) and `VITE_BYPASS_WAITLIST`. Both are read through `src/lib/auth-mode.ts` and baked into the bundle at build time.

## Validating Your Config

The backend validates every variable on startup. Common hits:

- `BETTER_AUTH_SECRET: String must contain at least 1 character(s)` — set it.
- `powersyncJwtSecret must be at least 32 characters when powersyncUrl is set` — regenerate with `openssl rand -hex 32`.
- `AUTH_MODE: Invalid enum value` — must be `consumer`, `oidc`, or `saml` (case-insensitive).
