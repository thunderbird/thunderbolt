# Configuration

Thunderbolt's API is configured entirely through environment variables, read once at startup, so **restart the API after any change**. A missing or invalid required value stops the process at startup, with a message naming the setting.

## Start here: the minimum

| Variable               | What it is                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | Random string used to sign sessions. Generate with `openssl rand -hex 32`.                                          |
| `DATABASE_URL`         | PostgreSQL connection string.                                                                                       |
| One model provider key | `ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY`, or `TINFOIL_API_KEY`. Without one, the API runs but cannot answer a chat. |

Add `POWERSYNC_URL` and `POWERSYNC_JWT_SECRET` if you want conversations to sync between a user's devices. Everything else below has a working default.

## Core URLs and server

Get `APP_URL` and `BETTER_AUTH_URL` wrong and sign-in redirects land on the wrong host.

| Variable          | Default                                        | What it does                                                                                      |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `APP_URL`         | `http://localhost:1420`                        | Public URL where users reach the web app. Used in emails and redirects.                           |
| `BETTER_AUTH_URL` | `http://localhost:8000`                        | Public URL of the API itself. Must match the redirect URI registered with your identity provider. |
| `PORT`            | `8000`                                         | Port the API listens on.                                                                          |
| `HOST`            | `0.0.0.0` in production, `localhost` otherwise | Network interface to bind. The published container image runs in production mode.                 |
| `WEB_CONCURRENCY` | One worker per CPU in production, 1 otherwise  | Number of worker processes.                                                                       |
| `LOG_LEVEL`       | `INFO`                                         | `DEBUG`, `INFO`, `WARN`, or `ERROR`.                                                              |
| `SWAGGER_ENABLED` | `false`                                        | Publishes an interactive API browser at `/v1/swagger`. Leave off in production.                   |

## Database

Thunderbolt stores accounts, sessions, and usage records in PostgreSQL. When sync is turned on, the database also holds the server-side copy of each user's synced data (conversations, settings, devices and the rest). With end-to-end encryption on, that copy is ciphertext your servers cannot read.

| Variable             | Default    | What it does                                                                                                                                                                |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | none       | PostgreSQL connection string. Required.                                                                                                                                     |
| `DATABASE_DRIVER`    | `postgres` | Set to `pglite` to run an embedded database with no PostgreSQL server. Sync does not work in this mode.                                                                     |
| `SKIP_MIGRATIONS`    | unset      | `true` skips the schema migration that normally runs at startup, for deployments that migrate separately.                                                                   |
| `MIGRATIONS_DIR`     | `drizzle`  | Location of the migration files, relative to the working directory.                                                                                                         |
| `POSTGRES_ADMIN_URL` | unset      | Admin connection used at container start to create the database named in `DATABASE_URL` if it does not exist. For shared PostgreSQL instances hosting several environments. |

Don't use the embedded `pglite` driver outside evaluation and testing. The sync service cannot replicate from it, and under this driver `DATABASE_URL` is a directory path rather than a connection string.

> Leave a `postgresql://` value in place under `pglite` and the API falls back to an in-memory database with only a warning in the log, losing everything on restart.

## Authentication

Pick one mode.

| Variable               | Default                                   | What it does                                                                                                           |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE`            | `consumer`                                | `consumer` for email codes plus optional Google and Microsoft sign-in, `oidc` or `saml` for enterprise SSO.            |
| `AUTH_ALLOW_ANONYMOUS` | `false`                                   | Lets visitors use the app without an account. Off by default, and the API rejects anonymous sign-in outright when off. |
| `TRUSTED_ORIGINS`      | `http://localhost:1420,tauri://localhost` | Comma-separated origins accepted for sign-in callbacks and identity provider discovery.                                |

`tauri://localhost` (the desktop and mobile apps) and the `BETTER_AUTH_URL` origin are always accepted, whatever you set.

### OIDC

| Variable             | Default                                           | What it does                                                                                              |
| -------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER`        | none                                              | Issuer URL. Required when `AUTH_MODE=oidc`.                                                               |
| `OIDC_CLIENT_ID`     | none                                              | Client ID registered with your provider.                                                                  |
| `OIDC_CLIENT_SECRET` | none                                              | Client secret.                                                                                            |
| `OIDC_DISCOVERY_URL` | `${OIDC_ISSUER}/.well-known/openid-configuration` | Override when the API reaches the provider at an internal hostname but tokens carry a browser-facing one. |

Works with any OIDC provider: Keycloak, Okta, Auth0, Entra ID, and others.

### SAML

| Variable           | Default | What it does                                                                      |
| ------------------ | ------- | --------------------------------------------------------------------------------- |
| `SAML_ENTRY_POINT` | none    | Identity provider sign-on URL. Required when `AUTH_MODE=saml`.                    |
| `SAML_ENTITY_ID`   | none    | Service provider entity ID. Must match the SAML client in your identity provider. |
| `SAML_IDP_ISSUER`  | none    | Identity provider entity ID.                                                      |
| `SAML_CERT`        | none    | Identity provider signing certificate, base64, without PEM headers.               |

Under either SSO mode, add the identity provider's origin to `TRUSTED_ORIGINS`, not to `CORS_ORIGINS`. Containerized deployments usually need two entries: the browser-facing issuer origin and the internal hostname the API uses to reach the provider.

### Social sign-in

Both providers are optional in consumer mode.

| Variable                  | Default |
| ------------------------- | ------- |
| `GOOGLE_CLIENT_ID`        | none    |
| `GOOGLE_CLIENT_SECRET`    | none    |
| `MICROSOFT_CLIENT_ID`     | none    |
| `MICROSOFT_CLIENT_SECRET` | none    |

The desktop app completes social sign-in through a local callback, trying three fixed ports in order. Register `http://localhost:17421`, `http://localhost:17422` and `http://localhost:17423` as redirect URIs with Google and Microsoft alongside your web one, or desktop sign-in fails.

### Tokens and CLI sign-in

Users create personal access tokens in the app so a script or the command-line client can call the API without an interactive sign-in.

| Variable                     | Default             | What it does                                                                                     |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `API_KEY_DEFAULT_EXPIRES_IN` | `7776000` (90 days) | Default lifetime, in seconds, of a personal access token.                                        |
| `DEVICE_AUTH_EXPIRES_IN`     | `30m`               | How long a code shown by the command-line client stays valid. Digits plus `s`, `m`, `h`, or `d`. |
| `DEVICE_AUTH_INTERVAL`       | `5s`                | Minimum interval at which the command-line client polls while waiting for approval.              |

## Models and inference

Set a key for each provider you want available. A provider with no key does not appear.

| Variable              | Default                           | Provider                                                                                                               |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | none                              | Anthropic (Claude)                                                                                                     |
| `ANTHROPIC_BASE_URL`  | `https://api.anthropic.com`       | Anthropic API root, without `/v1`. Leave it alone unless you are pointing the API at a stand-in during testing.        |
| `FIREWORKS_API_KEY`   | none                              | Fireworks                                                                                                              |
| `TINFOIL_API_KEY`     | none                              | Tinfoil, a confidential tier that runs models inside verified secure hardware, so the provider cannot read the request |
| `TINFOIL_ENCLAVE_URL` | `https://inference.tinfoil.sh/v1` | Tinfoil endpoint. Keep the `/v1` suffix.                                                                               |
| `EXA_API_KEY`         | none                              | Exa, used for web search                                                                                               |

There is no server setting for a custom OpenAI-compatible endpoint. Users add those themselves in the app, including a local Ollama or llama.cpp server, and those keys stay on the user's device.

The list of models offered by default is built into the API image rather than configured, so changing it means rebuilding.

### Spending limits

Rolling caps on what the API will spend on model usage per user, in whole cents. Anonymous sessions get less because they cost an attacker nothing to create.

| Variable                              | Default | Window                     |
| ------------------------------------- | ------- | -------------------------- |
| `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS`  | `10`    | Anonymous, rolling 5 hours |
| `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS`  | `60`    | Anonymous, rolling 7 days  |
| `INFERENCE_QUOTA_REGISTERED_5H_CENTS` | `1500`  | Signed in, rolling 5 hours |
| `INFERENCE_QUOTA_REGISTERED_7D_CENTS` | `7500`  | Signed in, rolling 7 days  |

Enabling `CONFIDENTIAL_API_KEYS_ENABLED`, `false` by default, lets a personal access token use the confidential tier, which otherwise takes an interactive session.

## Sync

The sync service (PowerSync) is a separate component of the deployment, replicating each user's data to their other devices. Leave `POWERSYNC_URL` unset to run without sync; the app still works on one device at a time.

| Variable                         | Default | What it does                                                                                    |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `POWERSYNC_URL`                  | none    | URL of your sync service, as the browser reaches it. Setting it turns sync on.                  |
| `POWERSYNC_JWT_SECRET`           | none    | Shared signing secret. Required once `POWERSYNC_URL` is set, minimum 32 characters.             |
| `POWERSYNC_JWT_KID`              | none    | Key identifier, so the sync service can pick between secrets during a rotation.                 |
| `POWERSYNC_TOKEN_EXPIRY_SECONDS` | `3600`  | Lifetime, in seconds, of the short-lived token each client uses to connect to the sync service. |

The secret and key identifier must match the values your sync service loads. If you generate the secret in base64, use base64url: a value containing `+`, `/`, or `=` is rejected by the sync service.

```bash
openssl rand 32 | basenc --base64url --wrap=0
```

## Encryption

| Variable       | Default | What it does                                                                                                                          |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `E2EE_ENABLED` | `false` | Encrypts message content on the device before it syncs, and requires each new device to be approved from one the user already trusts. |

Apps read the setting from the API at startup, so there is no matching client setting.

> Because the servers then hold only ciphertext, an administrator cannot recover a user's data for them. Each user is shown a 24-word recovery phrase once, at setup, and it is the only way back in if every trusted device is lost.

## Agents

An agent is the assistant behind a conversation. Thunderbolt ships a built-in one and can offer others alongside it, including ones you run yourself.

| Variable                 | Default | What it does                                                                                       |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `ENABLED_AGENTS`         | empty   | Comma-separated list of agent identifiers to offer. Empty means offer all of them.                 |
| `ALLOW_CUSTOM_AGENTS`    | `true`  | `false` hides the option to add a custom agent, so users cannot connect their own.                 |
| `DISABLE_BUILT_IN_AGENT` | `false` | `true` removes the built-in Thunderbolt agent entirely, for deployments that offer only their own. |

### Deepset (Haystack) pipelines

These four settings are optional. They add Deepset Cloud pipelines, which answer from your own document collections, to the agents users can pick.

| Variable             | What it is                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `HAYSTACK_BASE_URL`  | Deepset Cloud API root, for example `https://api.cloud.deepset.ai`.                                                                       |
| `HAYSTACK_API_KEY`   | Deepset API token.                                                                                                                        |
| `HAYSTACK_WORKSPACE` | Workspace slug.                                                                                                                           |
| `HAYSTACK_PIPELINES` | JSON array of pipelines to offer. Each entry needs `id`, `name`, `pipelineName`, and `pipelineId`; `description` and `icon` are optional. |

```bash
HAYSTACK_PIPELINES='[{"id":"rag-chat","name":"RAG Chat","pipelineName":"rag-chat-pipeline","pipelineId":"15cf8b39-0000-0000-0000-000000000000","icon":"book"}]'
```

A pipeline that should accept file attachments needs `"supportedContent": {"text": true, "files": true}`. Without it attachments never reach the pipeline, and it is run as a chat pipeline rather than a generative one.

## Email

Sign-in codes and waitlist notices are sent through Resend.

| Variable                    | Default | What it does                                                                                                          |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`            | none    | Sending key. Leave it unset and no mail is sent, which is fine for local evaluation but breaks sign-in in production. |
| `RESEND_MONITORING_API_KEY` | none    | Separate full-access key used only by the email health check, so the sending key can stay send-only.                  |

Mail goes out from a Thunderbolt-owned sender address, `hello@auth.thunderbolt.io`. There is no setting to change the from address or to use your own SMTP server.

## Browser access

| Variable                 | Default                                                          | What it does                                            |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `CORS_ORIGINS`           | `http://localhost:1420,tauri://localhost,http://tauri.localhost` | Comma-separated exact origins. No wildcards.            |
| `CORS_ALLOW_CREDENTIALS` | `true`                                                           | Whether browsers may send cookies.                      |
| `CORS_ALLOW_METHODS`     | `GET,POST,PUT,DELETE,PATCH,OPTIONS`                              | Permitted HTTP methods.                                 |
| `CORS_EXPOSE_HEADERS`    | a protocol-required list                                         | Response headers the browser makes readable to the app. |

Request headers need no configuration: the API echoes back whatever the browser asks for. Override `CORS_EXPOSE_HEADERS` only to add to the default list, never to shorten it, or the app loses responses it needs to read. `CORS_ALLOW_HEADERS` is accepted but ignored, and kept only so that older configuration files keep working.

## Rate limiting

| Variable             | Default | What it does                                                                                                               |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `true`  | Set `false` to switch limits off. Local evaluation only.                                                                   |
| `TRUSTED_PROXY`      | empty   | `cloudflare` trusts `CF-Connecting-IP`, `akamai` trusts `True-Client-IP`, empty trusts only the connecting socket address. |

> Don't set `TRUSTED_PROXY` unless you know exactly what sits in front of the API. Trusting the wrong header lets any client claim any IP and walk straight past the limits.

The limits themselves are not configurable:

| Request group           | Limit          |
| ----------------------- | -------------- |
| Chat responses          | 60 per minute  |
| Usage receipts          | 100 per minute |
| Tools, search, previews | 100 per minute |
| Sign-in                 | 10 per minute  |
| Debug transcript upload | 10 per hour    |

Signed-in requests are counted per user, anonymous ones per IP address. When an IP cannot be determined, those requests share a single bucket rather than skipping the limit, so the protection on sign-in and waitlist requests cannot quietly turn itself off.

Rejections return `429` with a `Retry-After` header.

## Minimum client version

| Variable          | Default | What it does                                                                                                               |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `MIN_APP_VERSION` | empty   | Lowest app version allowed to talk to this deployment, as three dot-separated numbers (`0.2.0`). Empty disables the check. |

Older clients receive `426 Upgrade Required` and prompt the user to update. The check fails closed: a client that sends no version is treated as too old, and a personal access token earns no exemption, so scripts and the command-line client must send a version too. Sign-in callbacks, health checks, analytics capture and the startup configuration request are exempt, so a blocked user can still reach the update prompt.

## Command-line client rollout

`CLI_DEVICE_REGISTRATION_ENABLED`, `false` by default, allows the command-line client to register as a device.

Enable it only after every app your users run is new enough to recognise a command-line client in the device list, since an older app cannot display a kind of device it does not know about. Set `MIN_APP_VERSION` first if you cannot be sure.

## Waitlist

| Variable                        | Default | What it does                                                                            |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | none    | Comma-separated email domains approved on sight, for example `example.com,example.org`. |
| `WAITLIST_ENABLED`              | `false` | Accepted and validated, but currently has no effect.                                    |

The waitlist check runs on email-code sign-in regardless of `WAITLIST_ENABLED`: an address with no existing account and no approved waitlist entry gets a "you're on the list" email instead of a sign-in code. Deployments on OIDC or SAML are unaffected, and so is social sign-in.

> If your deployment uses email codes, set `WAITLIST_AUTO_APPROVE_DOMAINS` to your own domains. Nobody new can sign in until you do.

## Analytics and tracing

| Variable                      | Default                    | What it does                                                                                                        |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POSTHOG_API_KEY`             | none                       | Leave unset to send no analytics. This is the off switch.                                                           |
| `POSTHOG_HOST`                | `https://us.i.posthog.com` | Point at your own PostHog instance if you run one.                                                                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none                       | OpenTelemetry trace collector endpoint, for example `http://localhost:4318/v1/traces`. Setting it turns tracing on. |
| `OTEL_EXPORTER_OTLP_TOKEN`    | none                       | Bearer token, for collectors that require one.                                                                      |

Tracing has been exercised against BetterStack, Jaeger, Zipkin, New Relic, and Grafana Cloud.

## Health checks

`/v1/health` is open and returns quickly. It is what a load balancer or liveness probe should poll. The deeper checks below each exercise one dependency and require a bearer token.

| Variable           | Default | What it does                                     |
| ------------------ | ------- | ------------------------------------------------ |
| `MONITORING_TOKEN` | none    | Bearer token for the routes under `/v1/health/`. |

```bash
curl -H "Authorization: Bearer $MONITORING_TOKEN" https://api.example.com/v1/health/database
```

| Route                  | What it checks                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `/v1/health/database`  | A trivial query against PostgreSQL, 5 second deadline.                                       |
| `/v1/health/powersync` | Sync service liveness, 5 seconds.                                                            |
| `/v1/health/email`     | That Resend accepts your key and your sending domain is verified, 10 seconds. Sends no mail. |
| `/v1/health/models`    | One tiny completion against every model offered, 20 seconds each.                            |

Healthy is `200` with `{"status":"ok"}`, unhealthy is `503` with a short reason. Reasons never include upstream response bodies or credentials. Don't poll the models check on a tight interval: every call spends real money on a completion. We recommend 15 minutes.

If `MONITORING_TOKEN` is unset these routes return `403` and run no checks. A wrong token returns `401`.

## Debug transcripts

Users can send a conversation transcript to the Thunderbolt team for troubleshooting. The option is hidden unless you configure it, and your own deployment forwards the transcript without storing it.

| Variable                          | Default | What it does                                                                                |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `DEBUG_TRANSCRIPT_UPSTREAM_URL`   | empty   | Where transcripts are forwarded. Set together with the key.                                 |
| `DEBUG_TRANSCRIPT_UPSTREAM_KEY`   | empty   | Your deployment's key, issued by the Thunderbolt team. Server-side only.                    |
| `DEBUG_TRANSCRIPT_INTAKE_ENABLED` | `false` | Receives transcripts from other deployments. Only the Thunderbolt-hosted service sets this. |

Contact the team with a deployment name to get a key.

> Understand what leaves your infrastructure before you enable this. Credentials and API keys are stripped, but identifying details are not: a transcript carries the conversation itself, along with the user ID and email your deployment holds (both blank for anonymous users). The Thunderbolt team retains what it receives, and a transcript survives deletion of the account that submitted it.

## Frontend build settings

The web app is a static bundle, so these are fixed when its image is built, not when it runs. The published frontend image accepts them as Docker build arguments.

| Build argument               | Default | What it does                                                                         |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Where the app calls the API. A relative path works when a reverse proxy fronts both. |
| `VITE_AUTH_MODE`             | `sso`   | `sso` for OIDC or SAML, anything else for consumer sign-in.                          |

Two further settings are read when the app is built but are not offered as build arguments, so you can only set them by building the image yourself: `VITE_AUTH_ENABLE_ANONYMOUS` (the client half of `AUTH_ALLOW_ANONYMOUS`; both must agree) and `VITE_IROH_RELAY_URL` (a self-hosted relay for the command-line bridge, defaulting to the public relays).

## Common startup errors

| What it reports                                       | Fix                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` is empty                         | Set it. `openssl rand -hex 32`.                                                           |
| The sync signing secret is shorter than 32 characters | Generate a longer `POWERSYNC_JWT_SECRET`, and update the sync service to match.           |
| `AUTH_MODE` is not a recognised value                 | Must be `consumer`, `oidc`, or `saml`.                                                    |
| `MIN_APP_VERSION` is not a version number             | Use three dot-separated numbers, for example `0.2.0`, or clear it.                        |
| `DATABASE_URL` is required with the `postgres` driver | Set a connection string, or set `DATABASE_DRIVER=pglite` for evaluation.                  |
| The debug transcript URL and key must be set together | Set both `DEBUG_TRANSCRIPT_UPSTREAM_URL` and `DEBUG_TRANSCRIPT_UPSTREAM_KEY`, or neither. |
