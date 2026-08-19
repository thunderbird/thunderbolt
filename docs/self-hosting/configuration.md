# Configuration

Thunderbolt's backend is configured through environment variables. The schema lives at [backend/src/config/settings.ts](../backend/src/config/settings.ts) and is validated with Zod on startup — misconfiguration fails loud, not silent.

Copy the example to a `.env` file and customize:

```bash
cp backend/.env.example backend/.env
```

Variables marked **required** must be set before the backend will start.

## Authentication

| Variable                  | Default                                           | Required | Description                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE`               | `consumer`                                        |          | `consumer` for magic-link + Google/Microsoft OAuth, `oidc` for OIDC SSO, `saml` for SAML SSO                                                                                                       |
| `BETTER_AUTH_SECRET`      | —                                                 | **yes**  | Non-empty string used to sign sessions. Generate with `openssl rand -hex 32`.                                                                                                                      |
| `BETTER_AUTH_URL`         | `http://localhost:8000`                           |          | Public URL the backend is served at; used in OAuth redirects                                                                                                                                       |
| `GOOGLE_CLIENT_ID`        | —                                                 |          | Google OAuth client ID (consumer mode)                                                                                                                                                             |
| `GOOGLE_CLIENT_SECRET`    | —                                                 |          | Google OAuth client secret                                                                                                                                                                         |
| `MICROSOFT_CLIENT_ID`     | —                                                 |          | Microsoft OAuth client ID                                                                                                                                                                          |
| `MICROSOFT_CLIENT_SECRET` | —                                                 |          | Microsoft OAuth client secret                                                                                                                                                                      |
| `OIDC_ISSUER`             | —                                                 |          | OIDC issuer URL (required when `AUTH_MODE=oidc`)                                                                                                                                                   |
| `OIDC_DISCOVERY_URL`      | `${OIDC_ISSUER}/.well-known/openid-configuration` |          | Optional override for the OIDC discovery endpoint. Use when backend reaches the IdP at an internal hostname (e.g. `http://keycloak:8080/...`) but tokens are issued with a browser-facing hostname |
| `OIDC_CLIENT_ID`          | —                                                 |          | OIDC client ID                                                                                                                                                                                     |
| `OIDC_CLIENT_SECRET`      | —                                                 |          | OIDC client secret                                                                                                                                                                                 |
| `SAML_ENTRY_POINT`        | —                                                 |          | SAML IdP SSO URL (required when `AUTH_MODE=saml`)                                                                                                                                                  |
| `SAML_ENTITY_ID`          | —                                                 |          | SP entity ID — must match the SAML client ID in the IdP (e.g. `thunderbolt-saml-sp`)                                                                                                               |
| `SAML_IDP_ISSUER`         | —                                                 |          | IdP entity ID / issuer (e.g. `https://keycloak.example.com/realms/thunderbolt`)                                                                                                                    |
| `SAML_CERT`               | —                                                 |          | SAML IdP signing certificate (base64, no PEM headers)                                                                                                                                              |

Consumer mode uses [Better Auth](https://better-auth.com)'s magic-link flow by default (email-delivered OTP). Hook up a provider by also setting the OAuth credentials above. Enterprise mode delegates entirely to an OIDC or SAML identity provider (Keycloak by default). See [OIDC local dev](../../backend/docs/oidc-local-dev.md) and [SAML local dev](../../backend/docs/saml-local-dev.md) for setup guides.

**Important:** When using `AUTH_MODE=oidc` or `saml`, the IdP origin must be included in `TRUSTED_ORIGINS` (see CORS section below). The SSO plugin validates discovery/metadata URLs against this list.

## AI Provider Keys

Set any subset; the app exposes each provider whose key is present.

| Variable                        | Description                                 |
| ------------------------------- | ------------------------------------------- |
| `ANTHROPIC_API_KEY`             | Anthropic (Claude)                          |
| `FIREWORKS_API_KEY`             | Fireworks                                   |
| `MISTRAL_API_KEY`               | Mistral                                     |
| `EXA_API_KEY`                   | Exa search (for web-grounded retrieval)     |
| `THUNDERBOLT_INFERENCE_URL`     | Custom OpenAI-compatible inference endpoint |
| `THUNDERBOLT_INFERENCE_API_KEY` | Key for the custom inference endpoint       |

User-level keys (e.g. OpenAI, OpenRouter) are configured in the app itself, not as backend env vars. For local inference, point `THUNDERBOLT_INFERENCE_URL` at an Ollama or llama.cpp server.

## PowerSync

| Variable                         | Default | Required         | Description                                                               |
| -------------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `POWERSYNC_URL`                  | —       | yes (for sync)   | URL of the PowerSync service (e.g. `http://localhost:8080` for local dev) |
| `POWERSYNC_JWT_SECRET`           | —       | yes when URL set | HS256 secret shared with PowerSync; must be **≥ 32 characters**           |
| `POWERSYNC_JWT_KID`              | —       |                  | Key ID for PowerSync to pick among multiple secrets during rotation       |
| `POWERSYNC_TOKEN_EXPIRY_SECONDS` | `3600`  |                  | PowerSync JWT lifetime                                                    |

The JWT secret must match the `k` value the PowerSync service loads at runtime. For self-hosted deploys, `deploy/config/powersync-config.yaml` reads it from the `PS_JWT_KEY_BASE64` env var (base64 of the raw secret); `POWERSYNC_JWT_KID` on the backend must match `PS_JWT_KID` set on the PowerSync service. For local dev, both values are baked into `powersync-service/config/config.yaml`.

## CORS

| Variable                 | Default                                                          | Description                                                                        |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `CORS_ORIGINS`           | `http://localhost:1420,tauri://localhost,http://tauri.localhost` | Exact-match allowed origins (comma-separated)                                      |
| `CORS_ALLOW_CREDENTIALS` | `true`                                                           | Whether browsers may send cookies                                                  |
| `CORS_ALLOW_METHODS`     | `GET,POST,PUT,DELETE,PATCH,OPTIONS`                              | Allowed HTTP methods                                                               |
| `CORS_ALLOW_HEADERS`     | _(see [settings.ts](../backend/src/config/settings.ts))_         | Allowed request headers. **Add any new `X-*` header you introduce in the client.** |
| `CORS_EXPOSE_HEADERS`    | _(see `settings.ts`)_                                            | Response headers exposed to the client                                             |

When you add a new custom header to a client request (e.g. `X-Device-ID`), you **must** add it to `CORS_ALLOW_HEADERS` — otherwise browser preflight fails and the request never reaches your handler.

## Analytics

| Variable          | Default                    | Description                                  |
| ----------------- | -------------------------- | -------------------------------------------- |
| `POSTHOG_HOST`    | `https://us.i.posthog.com` | PostHog instance hostname                    |
| `POSTHOG_API_KEY` | —                          | Leave unset to disable server-side analytics |

See [TELEMETRY.md](../TELEMETRY.md) in the repo for the full list of events the client emits.

## Rate Limiting and Proxy Trust

| Variable             | Default | Description                                                                                               |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `true`  | Set to `false` to disable rate limiting (local dev only)                                                  |
| `TRUSTED_PROXY`      | `""`    | `cloudflare` trusts `CF-Connecting-IP`, `akamai` trusts `True-Client-IP`, empty trusts only the socket IP |

Trusting the wrong proxy header lets a client spoof its IP for rate-limit bypass. Leave this empty unless you know your edge.

## App Version Gate

| Variable          | Default | Description                                                                                                                                                                                                                                          |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_APP_VERSION` | `""`    | Minimum client version (semver). Empty disables the gate. When set, requests from older clients get `426 Upgrade Required`, except on exempt bootstrap/callback routes (`/v1/config`, `/v1/health`, SSO/device callbacks, PostHog, proxy WebSocket). |

Settings are read once at startup, so **restart the backend** after changing `MIN_APP_VERSION` — it is not picked up live.

## Enterprise Key Escrow (POC)

End-to-end encryption is always on, and by default **you cannot read your users' data** — keys never leave their devices. This optional feature gives the deployment operator a second way in: every account key also gets wrapped to an escrow key you control, letting you decrypt any user's data out of band.

You generate the keypair; the server is only ever given the public half.

```bash
openssl ecparam -name prime256v1 -genkey -noout -out escrow.key
openssl ec -in escrow.key -pubout -outform DER | tail -c 65 | openssl base64 -A   # -> ORG_KMS_ESCROW_STATIC_PUBLIC_KEY
```

| Variable                           | Default | Description                                                                                |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `ORG_KMS_ESCROW_ENABLED`           | `false` | Turn escrow on. Changes the privacy promise for your users — read the caveats below first. |
| `ORG_KMS_ESCROW_STATIC_PUBLIC_KEY` | —       | Base64 raw uncompressed P-256 point (65 bytes) — the public half of the keypair above.     |

Before enabling:

- **Users are not notified.** A consent/disclosure UI is not part of this preview.
- **It is not retroactive.** Only accounts that set up a first device, rotate keys, or migrate _after_ you enable it get an escrow copy. Existing accounts stay unreadable until they next produce an account key.
- **Guard the private key.** Whoever holds `escrow.key` can decrypt every escrowed account, forever, with no trace in this system. Store it offline — a vault, an HSM, or paper. Never put it on the app server, which is deliberately never given a copy and so cannot read the envelopes it stores.
- **Clients trust the server for the escrow key.** They wrap against whatever `GET /v1/encryption/org-key` returns, without pinning, so a compromised backend can substitute its own key and collect account keys from that point on. Key pinning is not part of this preview.
- **The server refuses to boot on misconfiguration**, rather than failing silently: escrow enabled without a valid on-curve P-256 public key is a startup error.
- **Enabling it is a client cutover.** Once on, every AK-producing request must carry an `orgEnvelope`, so clients older than the release that added escrow get a hard 400 on setup, rotation and migration. Raise `MIN_APP_VERSION` alongside it (see App Version Gate above).

To decrypt, run the standalone tool from a checkout — it talks to Postgres directly and never through the app:

```bash
ORG_KMS_ESCROW_STATIC_PRIVATE_KEY=$(openssl pkcs8 -topk8 -nocrypt -in escrow.key -outform DER | openssl base64 -A) \
DATABASE_URL=postgres://user:pass@host:5432/db \
bun run scripts/kms-escrow-decrypt.ts \
  --user-id <id> --table chat_messages --column content --row-id <id>
```

Both secrets go through the environment on purpose. Anything on argv — the key _or_ the connection string's password — is visible to every other user on the box via `ps` and lands in shell history. Pass `--static-private-key-file <path>` if you'd rather not put the key in the environment either; `--db-url` also still works when the password isn't sensitive.

**Using a KMS-resident key instead.** The server only needs a P-256 public key, so it doesn't care where the private half lives — including inside a KMS or HSM that won't export it. What changes is decryption: the bundled tool does the ECDH locally and therefore needs an exportable key. If yours isn't, replace the `deriveSharedSecret` step in `scripts/kms-escrow-decrypt.ts` with your KMS's key-agreement call and leave the rest alone, or write your own recovery tool against the envelope format. Two things to know before committing to that path: your KMS must expose **raw elliptic-curve key agreement** (not all do — many offer only RSA unwrap), and it must return the raw shared secret with no KDF applied, since the tool derives the wrapping key itself.

See [End-to-End Encryption](../architecture/e2e-encryption.md#enterprise-kms-escrow-poc) for the key hierarchy and envelope format.

## Waitlist

| Variable                        | Default | Description                                                       |
| ------------------------------- | ------- | ----------------------------------------------------------------- |
| `WAITLIST_ENABLED`              | `false` | Flip to `true` to require approval before new sign-ups can log in |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | —       | Comma-separated email domains that skip the waitlist queue        |

## OpenTelemetry (Optional)

OpenTelemetry traces are enabled automatically when these are set. Not part of the Zod schema — the backend reads them from `process.env` directly.

| Variable                      | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TOKEN`    | Bearer token for authenticated collectors                   |

Tested with BetterStack, Jaeger, Zipkin, New Relic, Grafana Cloud, and any OTLP-compatible collector.

## General

| Variable           | Default                 | Description                                                           |
| ------------------ | ----------------------- | --------------------------------------------------------------------- |
| `PORT`             | `8000`                  | HTTP port the backend listens on                                      |
| `APP_URL`          | `http://localhost:1420` | Public URL where the frontend is served                               |
| `LOG_LEVEL`        | `INFO`                  | One of `DEBUG`, `INFO`, `WARN`, `ERROR`                               |
| `SWAGGER_ENABLED`  | `false`                 | Expose `/v1/swagger` with the full OpenAPI spec (don't in production) |
| `MONITORING_TOKEN` | —                       | Shared secret for authenticated `/health` checks                      |

## Frontend Build Args

The web/desktop bundle accepts two Vite env vars, passed as Dockerfile build args in `deploy/docker/frontend.Dockerfile`:

| Arg                          | Default | Purpose                                                                |
| ---------------------------- | ------- | ---------------------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Backend API URL (relative path, proxied by nginx or ALB)               |
| `VITE_AUTH_MODE`             | `sso`   | Auth mode — `sso` for enterprise SSO (OIDC or SAML), omit for consumer |

## Validating Your Config

The backend validates every variable on startup. Common hits:

- `BETTER_AUTH_SECRET: String must contain at least 1 character(s)` — set it.
- `powersyncJwtSecret must be at least 32 characters when powersyncUrl is set` — regenerate with `openssl rand -hex 32`.
- `AUTH_MODE: Invalid enum value` — must be `consumer`, `oidc`, or `saml` (case-insensitive).
