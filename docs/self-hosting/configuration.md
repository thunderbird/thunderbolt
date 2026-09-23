# Configuration

Environment variables, validated with Zod on startup against the schema in [backend/src/config/settings.ts](../../backend/src/config/settings.ts). Misconfiguration fails at boot, never silently, and variables marked **required** must be set before the backend will start.

```bash
cp backend/.env.example backend/.env
```

## Database

| Variable             | Default                                                       | Required | Description                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | dev: `postgresql://postgres:postgres@localhost:5433/postgres` | **yes**  | Postgres connection string. Outside `NODE_ENV=development` the backend throws at import when it is unset and the driver is `postgres`.                                                                 |
| `DATABASE_DRIVER`    | `postgres`                                                    |          | Set to `pglite` for an embedded Postgres without Docker. PowerSync cannot replicate from PGlite, so sync is off.                                                                                       |
| `SKIP_MIGRATIONS`    | unset                                                         |          | `true` skips the startup migration run, for deployments that migrate out of band.                                                                                                                      |
| `MIGRATIONS_DIR`     | `<cwd>/drizzle`                                               |          | Override the Drizzle migrations folder.                                                                                                                                                                |
| `POSTGRES_ADMIN_URL` | none                                                          |          | Read by `deploy/docker/backend-entrypoint.sh`, not the backend. When set, the entrypoint creates the logical database named in `DATABASE_URL` before migrating (the shared-Postgres PR-preview model). |

Under `DATABASE_DRIVER=pglite`, `DATABASE_URL` is a _data directory path_ (`.pglite/data` in `backend/.env.example`). A value still shaped like a connection string falls back to in-memory with a warning, so an inherited `postgresql://…` cannot bootstrap a data directory inside `backend/` ([db/client.ts](../../backend/src/db/client.ts)).

## Authentication

| Variable                     | Default                                           | Required | Description                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_MODE`                  | `consumer`                                        |          | `consumer` for magic-link + Google/Microsoft OAuth, `oidc` for OIDC SSO, `saml` for SAML SSO                                                                                                                             |
| `AUTH_ALLOW_ANONYMOUS`       | `false`                                           |          | Registers Better Auth's anonymous plugin. Off by default, so `/v1/api/auth/sign-in/anonymous` returns 404. Pair it with the frontend `VITE_AUTH_ENABLE_ANONYMOUS` overlay or the UI offers a route the server rejects    |
| `BETTER_AUTH_SECRET`         | none                                              | **yes**  | Non-empty string used to sign sessions. Generate with `openssl rand -hex 32`.                                                                                                                                            |
| `BETTER_AUTH_URL`            | `http://localhost:8000`                           |          | Public URL the backend is served at; used in OAuth redirects                                                                                                                                                             |
| `TRUSTED_ORIGINS`            | `http://localhost:1420,tauri://localhost`         |          | Comma-separated origins Better Auth accepts for callbacks and SSO discovery/metadata. Read straight from `process.env`, outside the Zod schema; `tauri://localhost` and the `BETTER_AUTH_URL` origin are always appended |
| `GOOGLE_CLIENT_ID`           | none                                              |          | Google OAuth client ID (consumer mode)                                                                                                                                                                                   |
| `GOOGLE_CLIENT_SECRET`       | none                                              |          | Google OAuth client secret                                                                                                                                                                                               |
| `MICROSOFT_CLIENT_ID`        | none                                              |          | Microsoft OAuth client ID                                                                                                                                                                                                |
| `MICROSOFT_CLIENT_SECRET`    | none                                              |          | Microsoft OAuth client secret                                                                                                                                                                                            |
| `OIDC_ISSUER`                | none                                              |          | OIDC issuer URL (required when `AUTH_MODE=oidc`)                                                                                                                                                                         |
| `OIDC_DISCOVERY_URL`         | `${OIDC_ISSUER}/.well-known/openid-configuration` |          | Override the discovery endpoint when the backend reaches the IdP at an internal hostname (e.g. `http://keycloak:8080/...`) but tokens are issued with a browser-facing hostname                                          |
| `OIDC_CLIENT_ID`             | none                                              |          | OIDC client ID                                                                                                                                                                                                           |
| `OIDC_CLIENT_SECRET`         | none                                              |          | OIDC client secret                                                                                                                                                                                                       |
| `SAML_ENTRY_POINT`           | none                                              |          | SAML IdP SSO URL (required when `AUTH_MODE=saml`)                                                                                                                                                                        |
| `SAML_ENTITY_ID`             | none                                              |          | SP entity ID. Must match the SAML client ID in the IdP (e.g. `thunderbolt-saml-sp`)                                                                                                                                      |
| `SAML_IDP_ISSUER`            | none                                              |          | IdP entity ID / issuer (e.g. `https://keycloak.example.com/realms/thunderbolt`)                                                                                                                                          |
| `SAML_CERT`                  | none                                              |          | SAML IdP signing certificate (base64, no PEM headers)                                                                                                                                                                    |
| `DEVICE_AUTH_EXPIRES_IN`     | `30m`                                             |          | How long a device/user code from the RFC 8628 grant (used by the `thunderbolt` CLI) stays valid. Better Auth time string                                                                                                 |
| `DEVICE_AUTH_INTERVAL`       | `5s`                                              |          | Minimum polling gap the device grant asks clients to respect                                                                                                                                                             |
| `API_KEY_DEFAULT_EXPIRES_IN` | `7776000`                                         |          | Default personal-access-token lifetime in seconds (90 days). Callers may request another supported lifetime at creation                                                                                                  |

Consumer mode uses [Better Auth](https://better-auth.com) magic links (email OTP); add the OAuth credentials above for a provider. SSO modes delegate entirely to an OIDC or SAML IdP (Keycloak by default): [OIDC local dev](../../backend/docs/oidc-local-dev.md), [SAML local dev](../../backend/docs/saml-local-dev.md).

**Important:** under `oidc` or `saml`, the IdP origin must appear in `TRUSTED_ORIGINS` (a Better Auth setting, not `CORS_ORIGINS`), which the SSO plugin validates discovery/metadata URLs against. Containerized deploys need _both_ the browser-facing issuer origin and the internal discovery host: `deploy/docker-compose.yml` sets app origin, `http://localhost:${KEYCLOAK_PORT}`, and `http://keycloak:8080`.

### Desktop OAuth redirect URIs

The desktop app binds a loopback server to the first free port of `17421`, `17422`, `17423` (`src-tauri/src/commands.rs`). Register all three in your Google and Microsoft consoles; the web redirect alone means a hard sign-in failure on desktop. There is deliberately no random-port fallback, since providers reject unregistered ports: `bind_to_port` (`src-tauri/src/oauth_server.rs`) fails locally instead.

## AI Provider Keys

Set any subset; the app exposes each provider whose key is present.

| Variable              | Default                           | Description                                                                                     |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | none                              | Anthropic (Claude)                                                                              |
| `FIREWORKS_API_KEY`   | none                              | Fireworks                                                                                       |
| `EXA_API_KEY`         | none                              | Exa search (web-grounded retrieval)                                                             |
| `TINFOIL_API_KEY`     | none                              | Tinfoil, the confidential (attested enclave) tier                                               |
| `TINFOIL_ENCLAVE_URL` | `https://inference.tinfoil.sh/v1` | Enclave base URL. Include the `/v1` prefix; Tinfoil's OpenAI-compatible endpoints live under it |

Other base URLs are fixed in `backend/src/inference/client.ts`; no backend variable takes your own OpenAI-compatible endpoint. User-level keys (OpenAI, OpenRouter, and so on) are configured in the app, not as backend env vars: a local Ollama or llama.cpp server goes in the Add Model form's `custom` provider, which prefills `http://localhost:11434/v1`.

### Managed inference quotas

Rolling spend windows, positive integers in cents, spent against by `backend/src/inference/usage-ledger.ts`. Anonymous sessions get a smaller allowance because they cost an attacker nothing to create.

| Variable                              | Default |
| ------------------------------------- | ------- |
| `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`  | `10`    |
| `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`  | `60`    |
| `INFERENCE_QUOTA_REGISTERED_5H_CENTS` | `1500`  |
| `INFERENCE_QUOTA_REGISTERED_7D_CENTS` | `7500`  |

## Agents

| Variable                 | Default | Description                                                                                                                             |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLED_AGENTS`         | `""`    | Comma-separated agent IDs `GET /v1/agents` may expose. Empty means no filter: every registered provider is listed                       |
| `ALLOW_CUSTOM_AGENTS`    | `true`  | `false` makes the discovery response report `allowCustomAgents: false` and the UI hides "Add Custom Agent"                              |
| `DISABLE_BUILT_IN_AGENT` | `false` | `true` omits the built-in Thunderbolt agent from the client's agent list, for deployments shipping only their own agents                |
| `HAYSTACK_BASE_URL`      | none    | Deepset/Haystack API base URL                                                                                                           |
| `HAYSTACK_API_KEY`       | none    | Deepset/Haystack API key                                                                                                                |
| `HAYSTACK_WORKSPACE`     | none    | Deepset workspace slug; request URLs are `${base}/api/v1/workspaces/${workspace}/...`                                                   |
| `HAYSTACK_PIPELINES`     | none    | JSON array of pipeline descriptors: `[{id, name, pipelineName, pipelineId, description?, icon?, supportedContent?}]`, validated on read |

## PowerSync

| Variable                         | Default | Required         | Description                                                               |
| -------------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `POWERSYNC_URL`                  | none    | yes (for sync)   | URL of the PowerSync service (e.g. `http://localhost:8080` for local dev) |
| `POWERSYNC_JWT_SECRET`           | none    | yes when URL set | HS256 secret shared with PowerSync; must be **≥ 32 characters**           |
| `POWERSYNC_JWT_KID`              | none    |                  | Key ID for PowerSync to pick among multiple secrets during rotation       |
| `POWERSYNC_TOKEN_EXPIRY_SECONDS` | `3600`  |                  | PowerSync JWT lifetime                                                    |

`POWERSYNC_JWT_SECRET` must match the `k` value PowerSync loads at runtime, and `POWERSYNC_JWT_KID` its `PS_JWT_KID`. Self-hosted, `deploy/config/powersync-config.yaml` reads the secret from `PS_JWT_KEY_BASE64` (base64 of the raw secret); local dev bakes both into `powersync-service/config/config.yaml`.

## End-to-End Encryption

| Variable       | Default | Description                                                                                                                                     |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2EE_ENABLED` | `false` | Requires each device to complete the trust flow before it may sync, and turns on client-side encryption of the columns in `encryptedColumnsMap` |

There is no frontend variable: the client reads this from `GET /v1/config`. See [E2E encryption](../architecture/e2e-encryption.md) for the key hierarchy, approval flows, and covered columns.

## CORS

| Variable                 | Default                                                          | Description                                                                              |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`           | `http://localhost:1420,tauri://localhost,http://tauri.localhost` | Exact-match allowed origins (comma-separated)                                            |
| `CORS_ALLOW_CREDENTIALS` | `true`                                                           | Whether browsers may send cookies                                                        |
| `CORS_ALLOW_METHODS`     | `GET,POST,PUT,DELETE,PATCH,OPTIONS`                              | Allowed HTTP methods                                                                     |
| `CORS_ALLOW_HEADERS`     | `""`                                                             | Legacy, unused. No production mount reads it; kept for backward compat and test fixtures |
| `CORS_EXPOSE_HEADERS`    | _(see [settings.ts](../../backend/src/config/settings.ts))_      | Response headers the browser makes readable to client code                               |

Request headers need no configuration: both mounts ([cors.ts](../../backend/src/config/cors.ts), [posthog/routes.ts](../../backend/src/posthog/routes.ts)) pass `allowedHeaders: true` and echo back `Access-Control-Request-Headers`. `/v1/proxy` requires that, forwarding arbitrary upstream headers as `X-Proxy-Passthrough-*`, where a static allowlist would break preflight on every new provider header.

Response headers are the opposite: a browser can only read one named in `CORS_EXPOSE_HEADERS`.

## Analytics

| Variable          | Default                    | Description                                  |
| ----------------- | -------------------------- | -------------------------------------------- |
| `POSTHOG_HOST`    | `https://us.i.posthog.com` | PostHog instance hostname                    |
| `POSTHOG_API_KEY` | none                       | Leave unset to disable server-side analytics |

[TELEMETRY.md](../../TELEMETRY.md) lists every event the client emits.

## Debug Transcripts

Users can share a chat's debug transcript from the chat view; the button appears only when the relay is configured. Your deployment stores nothing, forwarding to the Thunderbolt intake under a key that identifies it.

| Variable                          | Default | Description                                                                           |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `DEBUG_TRANSCRIPT_UPSTREAM_URL`   | empty   | Base URL of the Thunderbolt API that receives transcripts. Set together with the key. |
| `DEBUG_TRANSCRIPT_UPSTREAM_KEY`   | empty   | Your deployment's client key, issued by the Thunderbolt team. Keep it server-side.    |
| `DEBUG_TRANSCRIPT_INTAKE_ENABLED` | `false` | Mounts the intake endpoint. Only the Thunderbolt-hosted deployment enables this.      |

Contact the Thunderbolt team with a deployment name to obtain a key. Transcripts carry the user id and email your deployment knows (blank when anonymous), are retained by the Thunderbolt team, and survive deletion of the submitting account.

## Rate Limiting and Proxy Trust

| Variable             | Default | Description                                                                                               |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `true`  | Set to `false` to disable rate limiting (local dev only)                                                  |
| `TRUSTED_PROXY`      | `""`    | `cloudflare` trusts `CF-Connecting-IP`, `akamai` trusts `True-Client-IP`, empty trusts only the socket IP |

Trusting the wrong proxy header lets a client spoof its IP to bypass the limit; leave it empty unless you know your edge.

Limits are hardcoded per tier in [backend/src/middleware/rate-limit.ts](../../backend/src/middleware/rate-limit.ts):

| Tier                      | Limit          |
| ------------------------- | -------------- |
| `inference`               | 60 per minute  |
| `receipt`                 | 100 per minute |
| `pro`                     | 100 per minute |
| `auth`                    | 10 per minute  |
| `debug-transcript`        | 10 per hour    |
| `debug-transcript-intake` | 600 per hour   |

Authenticated routes key on `user:<id>`, unauthenticated ones on the client IP. IP keying fails **closed**: unresolvable IPs share one `ip:unknown` bucket rather than skipping the limit, so the guard on abuse-prone endpoints (OTP send, waitlist join) cannot silently disable itself; identifiable clients keep their own bucket and are unaffected.

Limited responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a rejection is `429` with `Retry-After`. None are in the default `CORS_EXPOSE_HEADERS`.

The backend test preload (`backend/src/test-utils/test-setup.ts`) forces rate limiting off, because the limiter's transactions bypass PGlite's test isolation. `backend/src/middleware/rate-limit.test.ts` covers the middleware separately, with `enabled: true` on its own connection.

## App Version Gate

| Variable          | Default | Description                                                                                                                                                                                                                   |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_APP_VERSION` | `""`    | Minimum client version (semver). Empty disables the gate. When set, older clients get `426 Upgrade Required` outside the exempt prefixes. Semver-validated at startup, so a typo fails fast instead of reaching every client. |

The gate **fails closed**: a missing or unparseable `X-App-Version` is rejected like an outdated client. Only `appVersionExemptPrefixes` ([app-version.ts](../../backend/src/middleware/app-version.ts)) passes, covering callers that cannot attach the header: `/v1/config`, `/v1/health`, `/static`, `/v1/api/auth/sso`, `/v1/api/auth/device`, `/v1/posthog`, `/v1/proxy/ws` (no headers on a WebSocket handshake) and `/v1/debug-transcripts/intake` (server-to-server). `OPTIONS` is always exempt; matching is on segment boundaries, so `/v1/config` never exempts a future `/v1/configuration`.

Auth scheme grants no exemption: a personal access token on a gated route must send `X-App-Version`. Settings are read once at startup, so **restart the backend** after changing `MIN_APP_VERSION`.

## CLI Device Rollout

| Variable                          | Default | Description                                                          |
| --------------------------------- | ------- | -------------------------------------------------------------------- |
| `MIN_APP_VERSION`                 | `""`    | Minimum compatible app semver; empty disables client blocking        |
| `CLI_DEVICE_REGISTRATION_ENABLED` | `false` | Enables server-owned CLI device registration                         |
| `CONFIDENTIAL_API_KEYS_ENABLED`   | `false` | Lets a personal access token reach the confidential (Tinfoil) routes |

Three mandatory stages, in order:

1. **Existing clients:** ship web, desktop, and mobile schema/UI support for `deviceType: cli`. Without a guaranteed compatible installed base, set `MIN_APP_VERSION` before enabling CLI registration on the backend, or an older client gets a device type its schema cannot handle.
2. **Backend:** deploy the public catalog, CLI registration/logout, revocation enforcement, and managed inference routes. Changed default-model or usage-receipt inputs need an image rebuild.
3. **CLI:** publish the native artifacts last, or a new CLI finds a catalog the deployed backend does not implement.

## Waitlist

| Variable                        | Default | Description                                                                                   |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `WAITLIST_ENABLED`              | `false` | **Inert.** Parsed and validated, but nothing reads it                                         |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | none    | Comma-separated email domains that skip the queue; a matching address is approved on the spot |

The gate in [auth.ts](../../backend/src/auth/auth.ts) runs unconditionally on the email-OTP path: an address with no `user` row and no approved waitlist entry gets a "joined" or "not ready" email instead of a code, and is rejected again at sign-in. `settings.waitlistEnabled` has no reader outside test fixtures, though deployment configs still set it.

`WAITLIST_AUTO_APPROVE_DOMAINS` is the real escape hatch for a self-hosted consumer deployment. `VITE_BYPASS_WAITLIST=true` (`src/lib/auth-mode.ts`) only hides the modal; the backend still gates sign-in.

## OpenTelemetry (Optional)

Traces turn on automatically when these are set. Read from `process.env` directly, not the Zod schema.

| Variable                      | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TOKEN`    | Bearer token for authenticated collectors                   |

Tested with BetterStack, Jaeger, Zipkin, New Relic, Grafana Cloud, and other OTLP collectors.

## General

| Variable                    | Default                                        | Description                                                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | `8000`                                         | HTTP port the backend listens on                                                                                                                                                                                                         |
| `HOST`                      | `0.0.0.0` in production, `localhost` otherwise | Interface the backend binds to                                                                                                                                                                                                           |
| `WEB_CONCURRENCY`           | CPU count in production, `1` otherwise         | Worker processes forked by `backend/src/cluster.ts`                                                                                                                                                                                      |
| `APP_URL`                   | `http://localhost:1420`                        | Public URL where the frontend is served                                                                                                                                                                                                  |
| `LOG_LEVEL`                 | `INFO`                                         | One of `DEBUG`, `INFO`, `WARN`, `ERROR`                                                                                                                                                                                                  |
| `SWAGGER_ENABLED`           | `false`                                        | Expose `/v1/swagger` with the full OpenAPI spec (don't in production)                                                                                                                                                                    |
| `MONITORING_TOKEN`          | none                                           | Bearer token for deep health routes under `/v1/health/`                                                                                                                                                                                  |
| `RESEND_API_KEY`            | none                                           | Resend key for transactional email (sign-in codes, waitlist). Unset logs a warning at boot and skips sends, the usual local-dev setup; under `NODE_ENV=production` an unset key makes the send path throw `Email service not configured` |
| `RESEND_MONITORING_API_KEY` | none                                           | Full access Resend key used only by `/v1/health/email`, so `RESEND_API_KEY` may stay sending-only                                                                                                                                        |

### Deep health

Send `Authorization: Bearer <MONITORING_TOKEN>` to these GET routes:

| Route                  | Dependency exercised                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/v1/health/database`  | A trivial database query (5-second deadline)                                                                 |
| `/v1/health/powersync` | PowerSync's `/probes/liveness` endpoint (5 seconds)                                                          |
| `/v1/health/email`     | Resend's authenticated domains read (10 seconds; sends no email)                                             |
| `/v1/health/models`    | Every catalog model, including attested, encrypted Tinfoil completions (20 seconds per model, concurrency 3) |

Success is `200 {"status":"ok"}`; failure is `503 {"status":"failed","reason":"<code>"}`, except the models route: `{"status":"failed","failures":[{"model":"<catalog model>","reason":"no-text"}]}`. Model reasons are `no-text`, `timeout`, `upstream-error`, `missing-price`, `not-configured`, and never contain upstream bodies or credentials.

An unset token returns `403 {"error":"Monitoring token not configured"}`, a missing or wrong bearer `401 {"error":"Unauthorized"}`; rejected calls run no probes. The unauthenticated `/v1/health` stays available for load balancers and liveness probes.

The email probe reads the domain list with `RESEND_MONITORING_API_KEY` and needs the `emailFrom` domain verified. Reasons: `not-configured` (key missing, likewise missing PowerSync config), `rejected` (invalid, sending-only, or forbidden key; upstream 400/401/403), `domain-unverified` (missing or unverified sending domain, including a malformed response).

Each models call costs one tiny completion per priced catalog model, without retries. BetterStack polls it every 15 minutes in production.

## The `GET /v1/config` Boot Contract

Some variables above are published unauthenticated at `GET /v1/config`, fetched by every client at boot and cached in `localStorage` to keep working offline ([backend/src/api/config.ts](../../backend/src/api/config.ts)):

| Field                     | Source                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `e2eeEnabled`             | `E2EE_ENABLED`                                                                                                       |
| `debugTranscriptsEnabled` | Derived: true when `DEBUG_TRANSCRIPT_UPSTREAM_URL` is set                                                            |
| `builtInAgentEnabled`     | Inverse of `DISABLE_BUILT_IN_AGENT` (the env var reads as an opt-in switch, the wire field as a positive capability) |
| `allowCustomAgents`       | `ALLOW_CUSTOM_AGENTS`                                                                                                |
| `minAppVersion`           | `MIN_APP_VERSION`, **omitted** when unset so the client never parses `''` as semver                                  |
| `defaults.models`         | `{ version, defaultModelId, data }` from the shipped default model set                                               |

`defaults` is an over-the-air channel: the client compares the server's version against its bundled copy, so changed defaults reach existing installs without a client release. The payload is baked into the backend image, so changing it needs a backend rebuild.

## Frontend Build Args

`deploy/docker/frontend.Dockerfile` exposes two Vite env vars as build args:

| Arg                          | Default | Purpose                                                    |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Backend API URL (relative path, proxied by nginx or ALB)   |
| `VITE_AUTH_MODE`             | `sso`   | `sso` for enterprise SSO (OIDC or SAML), omit for consumer |

`VITE_AUTH_ENABLE_ANONYMOUS` (the client half of `AUTH_ALLOW_ANONYMOUS`) and `VITE_BYPASS_WAITLIST` are read through `src/lib/auth-mode.ts` and baked into the bundle, but are not build args: a custom build must pass them itself.

## Validating Your Config

Common startup validation errors:

- `BETTER_AUTH_SECRET: String must contain at least 1 character(s)`: set it.
- `powersyncJwtSecret must be at least 32 characters when powersyncUrl is set`: regenerate with `openssl rand -hex 32`.
- `AUTH_MODE: Invalid enum value`: must be `consumer`, `oidc`, or `saml` (case-insensitive).
