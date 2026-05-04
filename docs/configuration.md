# Configuration

Thunderbolt's backend is configured through environment variables. The schema lives at [backend/src/config/settings.ts](../backend/src/config/settings.ts) and is validated with Zod on startup — misconfiguration fails loud, not silent.

Copy the example to a `.env` file and customize:

```bash
cp backend/.env.example backend/.env
```

Variables marked **required** must be set before the backend will start.

## Authentication

| Variable                  | Default                    | Required | Description                                                                                 |
| ------------------------- | -------------------------- | :------: | ------------------------------------------------------------------------------------------- |
| `AUTH_MODE`               | `consumer`                 |          | `consumer` for magic-link + Google/Microsoft OAuth, `oidc` for self-hosted identity         |
| `BETTER_AUTH_SECRET`      | —                          | **yes**  | Non-empty string used to sign sessions. Generate with `openssl rand -hex 32`.               |
| `BETTER_AUTH_URL`         | `http://localhost:8000`    |          | Public URL the backend is served at; used in OAuth redirects                                |
| `GOOGLE_CLIENT_ID`        | —                          |          | Google OAuth client ID (consumer mode)                                                      |
| `GOOGLE_CLIENT_SECRET`    | —                          |          | Google OAuth client secret                                                                  |
| `MICROSOFT_CLIENT_ID`     | —                          |          | Microsoft OAuth client ID                                                                   |
| `MICROSOFT_CLIENT_SECRET` | —                          |          | Microsoft OAuth client secret                                                               |
| `OIDC_ISSUER`             | —                          |          | OIDC issuer URL (required when `AUTH_MODE=oidc`)                                            |
| `OIDC_CLIENT_ID`          | —                          |          | OIDC client ID                                                                              |
| `OIDC_CLIENT_SECRET`      | —                          |          | OIDC client secret                                                                          |

Consumer mode uses [Better Auth](https://better-auth.com)'s magic-link flow by default (email-delivered OTP). Hook up a provider by also setting the OAuth credentials above. Enterprise mode delegates entirely to an OIDC provider (Keycloak by default).

## AI provider keys

Set any subset; the app exposes each provider whose key is present.

| Variable                         | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY`              | Anthropic (Claude)                                   |
| `FIREWORKS_API_KEY`              | Fireworks                                            |
| `MISTRAL_API_KEY`                | Mistral                                              |
| `EXA_API_KEY`                    | Exa search (for web-grounded retrieval)              |
| `THUNDERBOLT_INFERENCE_URL`      | Custom OpenAI-compatible inference endpoint          |
| `THUNDERBOLT_INFERENCE_API_KEY`  | Key for the custom inference endpoint                |

User-level keys (e.g. OpenAI, OpenRouter) are configured in the app itself, not as backend env vars. For local inference, point `THUNDERBOLT_INFERENCE_URL` at an Ollama or llama.cpp server.

## PowerSync

| Variable                         | Default  | Required         | Description                                                                  |
| -------------------------------- | -------- | ---------------- | ---------------------------------------------------------------------------- |
| `POWERSYNC_URL`                  | —        | yes (for sync)   | URL of the PowerSync service (e.g. `http://localhost:8080` for local dev)    |
| `POWERSYNC_JWT_SECRET`           | —        | yes when URL set | HS256 secret shared with PowerSync; must be **≥ 32 characters**              |
| `POWERSYNC_JWT_KID`              | —        |                  | Key ID for PowerSync to pick among multiple secrets during rotation          |
| `POWERSYNC_TOKEN_EXPIRY_SECONDS` | `3600`   |                  | PowerSync JWT lifetime                                                       |

The JWT secret must match the `secret` in `powersync-service/config/config.yaml` (local dev) or in the PowerSync Cloud dashboard (production).

## CORS

| Variable                  | Default                                                              | Description                                                                    |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CORS_ORIGINS`            | `http://localhost:1420,tauri://localhost,http://tauri.localhost`     | Exact-match allowed origins (comma-separated)                                  |
| `CORS_ALLOW_CREDENTIALS`  | `true`                                                               | Whether browsers may send cookies                                              |
| `CORS_ALLOW_METHODS`      | `GET,POST,PUT,DELETE,PATCH,OPTIONS`                                  | Allowed HTTP methods                                                           |
| `CORS_ALLOW_HEADERS`      | _(see [settings.ts](../backend/src/config/settings.ts))_             | Allowed request headers. **Add any new `X-*` header you introduce in the client.** |
| `CORS_EXPOSE_HEADERS`     | _(see `settings.ts`)_                                                | Response headers exposed to the client                                         |

When you add a new custom header to a client request (e.g. `X-Device-ID`), you **must** add it to `CORS_ALLOW_HEADERS` — otherwise browser preflight fails and the request never reaches your handler.

## Analytics

| Variable          | Default                    | Description                                  |
| ----------------- | -------------------------- | -------------------------------------------- |
| `POSTHOG_HOST`    | `https://us.i.posthog.com` | PostHog instance hostname                    |
| `POSTHOG_API_KEY` | —                          | Leave unset to disable server-side analytics |

See [TELEMETRY.md](../TELEMETRY.md) in the repo for the full list of events the client emits.

## Rate limiting and proxy trust

| Variable             | Default | Description                                                                                               |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `true`  | Set to `false` to disable rate limiting (local dev only)                                                  |
| `TRUSTED_PROXY`      | `""`    | `cloudflare` trusts `CF-Connecting-IP`, `akamai` trusts `True-Client-IP`, empty trusts only the socket IP |

Trusting the wrong proxy header lets a client spoof its IP for rate-limit bypass. Leave this empty unless you know your edge.

## Waitlist

| Variable                        | Default | Description                                                       |
| ------------------------------- | ------- | ----------------------------------------------------------------- |
| `WAITLIST_ENABLED`              | `false` | Flip to `true` to require approval before new sign-ups can log in |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | —       | Comma-separated email domains that skip the waitlist queue        |

## OpenTelemetry (optional)

OpenTelemetry traces are enabled automatically when these are set. Not part of the Zod schema — the backend reads them from `process.env` directly.

| Variable                      | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TOKEN`    | Bearer token for authenticated collectors                   |

Tested with BetterStack, Jaeger, Zipkin, New Relic, Grafana Cloud, and any OTLP-compatible collector.

## General

| Variable           | Default                 | Description                                                          |
| ------------------ | ----------------------- | -------------------------------------------------------------------- |
| `PORT`             | `8000`                  | HTTP port the backend listens on                                     |
| `APP_URL`          | `http://localhost:1420` | Public URL where the frontend is served                              |
| `LOG_LEVEL`        | `INFO`                  | One of `DEBUG`, `INFO`, `WARN`, `ERROR`                              |
| `SWAGGER_ENABLED`  | `false`                 | Expose `/v1/swagger` with the full OpenAPI spec (don't in production) |
| `MONITORING_TOKEN` | —                       | Shared secret for authenticated `/health` checks                     |

## Frontend build args

The web/desktop bundle accepts two Vite env vars, passed as Dockerfile build args in `deploy/docker/frontend.Dockerfile`:

| Arg                          | Default | Purpose                                                                       |
| ---------------------------- | ------- | ----------------------------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Backend API URL (relative path, proxied by nginx or ALB)                      |
| `VITE_AUTH_MODE`             | `oidc`  | Auth mode — `oidc` for enterprise defaults, omit for consumer                 |

## Validating your config

The backend validates every variable on startup. Common hits:

- `BETTER_AUTH_SECRET: String must contain at least 1 character(s)` — set it.
- `powersyncJwtSecret must be at least 32 characters when powersyncUrl is set` — regenerate with `openssl rand -hex 32`.
- `AUTH_MODE: Invalid enum value` — must be `consumer` or `oidc` (case-insensitive).
