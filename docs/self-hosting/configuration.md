# Configuration

Thunderbolt's API is configured entirely through environment variables, read once at startup, so **restart the API after any change**. A missing or invalid required value stops the process at startup, with a message naming the setting.

## Start here: the minimum

| Variable               | What it is                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`   | Random string used to sign sessions. Generate with `openssl rand -hex 32`.                                                           |
| `DATABASE_URL`         | PostgreSQL connection string.                                                                                                        |
| One model provider key | `ANTHROPIC_API_KEY` or `TINFOIL_API_KEY`. Without one the deployment-provided models fail on send, and users must add their own key. |

Add `POWERSYNC_URL` and `POWERSYNC_JWT_SECRET` if you want conversations to sync between a user's devices. Everything else below has a working default.

## Core URLs and server

Get `APP_URL` and `BETTER_AUTH_URL` wrong and sign-in redirects land on the wrong host.

| Variable          | Default                                        | What it does                                                                                                  |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `APP_URL`         | `http://localhost:1420`                        | Public URL where users reach the web app. Used in emails and redirects.                                       |
| `BETTER_AUTH_URL` | `http://localhost:8000`                        | Public URL of the API itself. Must match the redirect URI registered with your identity provider.             |
| `PORT`            | `8000`                                         | Port the API listens on.                                                                                      |
| `HOST`            | `0.0.0.0` in production, `localhost` otherwise | Network interface to bind. The published container image runs in production mode.                             |
| `WEB_CONCURRENCY` | One worker per CPU in production, 1 otherwise  | Honoured only by the compiled single-binary build. The container image runs one process; scale with replicas. |
| `LOG_LEVEL`       | `INFO`                                         | `DEBUG`, `INFO`, `WARN`, or `ERROR`.                                                                          |
| `SWAGGER_ENABLED` | `false`                                        | Publishes an interactive API browser at `/v1/swagger`. Leave off in production.                               |

## Database

Thunderbolt stores accounts, sessions, and usage records in PostgreSQL. When sync is turned on, the database also holds the server-side copy of each user's synced data (conversations, settings, devices and the rest). Its content fields are encrypted on the device before upload, so your servers hold them as ciphertext they cannot read.

| Variable             | Default    | What it does                                                                                                                                                                |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | none       | PostgreSQL connection string. Required.                                                                                                                                     |
| `DATABASE_DRIVER`    | `postgres` | Set to `pglite` to run an embedded database with no PostgreSQL server. Sync does not work in this mode.                                                                     |
| `SKIP_MIGRATIONS`    | unset      | `true` skips the in-process migration pass. The container image's entrypoint runs `drizzle-kit migrate` regardless, so override the container command too.                  |
| `MIGRATIONS_DIR`     | `drizzle`  | Location of the migration files, relative to the working directory.                                                                                                         |
| `POSTGRES_ADMIN_URL` | unset      | Admin connection used at container start to create the database named in `DATABASE_URL` if it does not exist. For shared PostgreSQL instances hosting several environments. |

Don't use the embedded `pglite` driver outside evaluation and testing. The sync service cannot replicate from it, and under this driver `DATABASE_URL` is a directory path rather than a connection string.

> Leave a `postgresql://` value in place under `pglite` and the API falls back to an in-memory database with only a warning in the log, losing everything on restart.

## Authentication

Pick one mode.

| Variable               | Default                                   | What it does                                                                                                           |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE`            | `consumer`                                | `consumer` for email sign-in codes, `oidc` or `saml` for enterprise SSO.                                               |
| `AUTH_ALLOW_ANONYMOUS` | `false`                                   | Lets visitors use the app without an account. Off by default, and the API rejects anonymous sign-in outright when off. |
| `TRUSTED_ORIGINS`      | `http://localhost:1420,tauri://localhost` | Comma-separated origins accepted for sign-in callbacks and identity provider discovery.                                |

`tauri://localhost` (the desktop and mobile apps) and the `BETTER_AUTH_URL` origin are always accepted, whatever you set.

### First-time email sign-in

Under `AUTH_MODE=consumer`, an address with no account gets a sign-in code only once it is approved. Everyone else is put on a waitlist and receives a waitlist email instead of a code. Addresses that already have an account always get a code.

| Variable                        | Default | What it does                                                                                                     |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | empty   | Comma-separated email domains, for example `example.com,example.org`, whose addresses are approved on first use. |

Each entry must equal everything after the `@`, ignoring case, so `example.com` does not cover `mail.example.com`. The list is read once at startup, so restart the API after changing it.

To let in one address outside those domains, set its row in the `waitlist` table to `status = 'approved'`. There is no screen or command for this.

> `WAITLIST_ENABLED` appears in the packaged Compose, Helm and AWS configurations but has no effect. The waitlist always applies, so `WAITLIST_AUTO_APPROVE_DOMAINS` and the `waitlist` table are the only ways to let new addresses in.

### OIDC

| Variable             | Default                                     | What it does                                                                                                                                               |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER`        | none                                        | Issuer URL. Required when `AUTH_MODE=oidc`.                                                                                                                |
| `OIDC_CLIENT_ID`     | none                                        | Client ID registered with your provider.                                                                                                                   |
| `OIDC_CLIENT_SECRET` | none                                        | Client secret.                                                                                                                                             |
| `OIDC_DISCOVERY_URL` | `<issuer>/.well-known/openid-configuration` | Override when the API reaches the provider at an internal hostname but tokens carry a browser-facing one. A trailing slash on the issuer is dropped first. |

Works with any OIDC provider: Keycloak, Okta, Auth0, Entra ID, and others.

### SAML

| Variable           | Default | What it does                                                                      |
| ------------------ | ------- | --------------------------------------------------------------------------------- |
| `SAML_ENTRY_POINT` | none    | Identity provider sign-on URL. Required when `AUTH_MODE=saml`.                    |
| `SAML_ENTITY_ID`   | none    | Service provider entity ID. Must match the SAML client in your identity provider. |
| `SAML_IDP_ISSUER`  | none    | Identity provider entity ID.                                                      |
| `SAML_CERT`        | none    | Identity provider signing certificate, base64, without PEM headers.               |

Under OIDC, add the identity provider's origin to `TRUSTED_ORIGINS`, not to `CORS_ORIGINS`. SAML has no discovery step, so it does not need the entry. Containerized deployments usually need two entries: the browser-facing issuer origin and the internal hostname the API uses to reach the provider.

### Google and Microsoft connections

Optional, and not a sign-in method. These credentials power the Gmail, Calendar, Outlook and OneDrive integrations a signed-in user connects under Settings.

| Variable                  | Default |
| ------------------------- | ------- |
| `GOOGLE_CLIENT_ID`        | none    |
| `GOOGLE_CLIENT_SECRET`    | none    |
| `MICROSOFT_CLIENT_ID`     | none    |
| `MICROSOFT_CLIENT_SECRET` | none    |

The desktop app completes the consent flow through a local callback, trying three fixed ports in order and falling back to none. Register `http://localhost:17421`, `http://localhost:17422` and `http://localhost:17423` as redirect URIs with Google and Microsoft alongside your web one, or connecting an account from the desktop app fails.

### Tokens and CLI sign-in

Users create personal access tokens in the app so a script or the command-line client can call the API without an interactive sign-in.

| Variable                     | Default             | What it does                                                                                     |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `API_KEY_DEFAULT_EXPIRES_IN` | `7776000` (90 days) | Default lifetime, in seconds, of a personal access token.                                        |
| `DEVICE_AUTH_EXPIRES_IN`     | `30m`               | How long a code shown by the command-line client stays valid. Digits plus `s`, `m`, `h`, or `d`. |
| `DEVICE_AUTH_INTERVAL`       | `5s`                | Minimum interval at which the command-line client polls while waiting for approval.              |

## Models and inference

Set a key for each provider you want to fund. The shipped models are listed either way: without the matching key they look selectable and fail when a message is sent. See [Models](./models.md).

| Variable              | Default                           | Provider                                                                                                               |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | none                              | Anthropic (Claude)                                                                                                     |
| `ANTHROPIC_BASE_URL`  | `https://api.anthropic.com`       | Anthropic API root, without `/v1`. Leave it alone unless you are pointing the API at a stand-in during testing.        |
| `FIREWORKS_API_KEY`   | none                              | Accepted but currently unused. No shipped model routes to Fireworks.                                                   |
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

| Variable                         | Default         | What it does                                                                                                                                                                                                     |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POWERSYNC_URL`                  | none            | URL of your sync service, as the browser reaches it. Setting it turns sync on.                                                                                                                                   |
| `POWERSYNC_INTERNAL_URL`         | `POWERSYNC_URL` | Address the API itself uses to check the sync service for `/v1/health/powersync`. Set it when the public URL does not resolve inside your network.                                                               |
| `POWERSYNC_JWT_SECRET`           | none            | Shared signing secret. Required once `POWERSYNC_URL` is set, minimum 32 characters.                                                                                                                              |
| `POWERSYNC_JWT_KID`              | none            | Key identifier, so the sync service can pick between secrets during a rotation.                                                                                                                                  |
| `POWERSYNC_TOKEN_EXPIRY_SECONDS` | `300`           | Lifetime, in seconds, of the token each client uses to connect to the sync service. The sync service checks it without asking the API, so a revoked device keeps syncing until its token expires. Keep it short. |

The secret and key identifier must match the values your sync service loads. If you generate the secret in base64, use base64url: a value containing `+`, `/`, or `=` is rejected by the sync service.

```bash
openssl rand 32 | basenc --base64url --wrap=0
```

## Encryption

End-to-end encryption is always on, with nothing to set. The device encrypts message content and the other covered fields before they sync, and each new device has to be approved from one the user already trusts, or recovered with their recovery phrase. The apps decide this from their own key material, not from the server, so a compromised server cannot switch it off.

> Because the servers hold only ciphertext for that content, an administrator cannot recover a user's data for them unless you run [organizational key escrow](#organizational-key-escrow). Each user is shown a 24-word recovery phrase once, at setup, and it is the only way back in if every trusted device is lost.

**Upgrading from a release before 0.1.135**, where encryption was the `E2EE_ENABLED` setting:

1. Set `MIN_APP_VERSION=0.1.135` in the same deploy that moves the backend to 0.1.135 or later. Older apps then show an upgrade screen instead of uploading plain text or silently failing to sync.
2. Remove `E2EE_ENABLED`. Nothing reads it any more.

Rows synced in plain text before the upgrade stay in plain text on your server; there is no re-encryption pass. Devices set up afterwards never download them, so that data stays only on the devices that already had it. A device that was syncing without encryption has sync switched off when it updates, and resumes once the user finishes setup. Accounts that already used encryption are upgraded in place: the first device to open the new version shows the user a new recovery phrase once, and the old phrase stops working.

### Organizational key escrow

Off by default. When on, every encryption setup, key rotation and v1 to v2 upgrade must include an escrow envelope that wraps the account key to your organization's public key, so an operator can recover an account offline. The server never holds escrow key material and cannot change the key an account is wrapped to: the app wraps only to the public key built into it.

| Variable             | Default | What it does                                                                 |
| -------------------- | ------- | ---------------------------------------------------------------------------- |
| `ORG_ESCROW_ENABLED` | `false` | Requires and stores an escrow envelope on every setup, rotation and upgrade. |

**Order matters.** Build `VITE_ORG_ESCROW_PUBLIC_KEY` into the app (see [Frontend build settings](#frontend-build-settings)) before turning this on, or every setup, rotation and upgrade fails with a `400`. Generate the key pair with `scripts/org-escrow-keygen.ts` and keep the private half away from the app server. Recover offline with `scripts/org-escrow-decrypt.ts`, which reads the private key and database URL from `ORG_ESCROW_PRIVATE_KEY` and `DATABASE_URL`, or from `--private-key-file` and `--db-url-file`, never from command-line arguments, which `ps` shows to every process on the machine. Escrow is a proof of concept: classical P-256 only, and accounts set up before it was enabled are not backfilled.

## Agents

An agent is the assistant behind a conversation. Thunderbolt ships a built-in one and can offer others alongside it, including ones you run yourself.

| Variable                 | Default | What it does                                                                                       |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `ENABLED_AGENTS`         | empty   | Comma-separated list of agent identifiers to offer. Empty means offer all of them.                 |
| `ALLOW_CUSTOM_AGENTS`    | `true`  | `false` hides the option to add a custom agent, so users cannot connect their own.                 |
| `DISABLE_BUILT_IN_AGENT` | `false` | `true` removes the built-in Thunderbolt agent entirely, for deployments that offer only their own. |

### Hosted agent

`AGENT_ENABLED=true` mounts `POST /v1/agent/chat`, a stateless agent that runs inside the API: the client sends the whole conversation each turn and the server keeps nothing between requests. It needs a session (anonymous sessions are allowed), shares the `inference` rate limit and the [spending limits](#spending-limits), runs one reply at a time per user, and calls Anthropic with `ANTHROPIC_API_KEY`. `AGENT_MODEL` must be an Anthropic model with a row in the inference price table, otherwise requests fail with `503 INFERENCE_PRICE_UNAVAILABLE`. The agent has no tools yet.

The agent is also offered through agent discovery, and the discovery response names it as the default agent unless `ENABLED_AGENTS` excludes it. Excluding `hosted-agent` there hides it from discovery but does not unmount the route, the same as the Haystack route. The app starts honouring the default in an upcoming release.

A request may carry at most 2 MB and 200 messages (`413` and `400` beyond that), and a reply stops at 8,192 output tokens or after 2 minutes upstream.

| Variable                          | Default     | What it does                                                                |
| --------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `AGENT_ENABLED`                   | `false`     | Mounts the hosted agent. When `false` the route does not exist.             |
| `AGENT_MODEL`                     | empty       | Anthropic model the agent uses. Required once the agent is on.              |
| `AGENT_MAX_STEPS`                 | `8`         | Most tool-call steps per run. No effect until MCP tools land.               |
| `AGENT_SYSTEM_PROMPT`             | empty       | System prompt for the agent.                                                |
| `AGENT_MCP_SERVERS`               | empty       | JSON array of MCP servers the agent may call. No effect yet.                |
| `AGENT_NAME`                      | `Assistant` | Name shown when clients discover the agent.                                 |
| `AGENT_DESCRIPTION`               | empty       | Description shown when clients discover the agent.                          |
| `AGENT_ICON`                      | empty       | Icon shown when clients discover the agent.                                 |
| `ALLOW_ANONYMOUS_AGENT_DISCOVERY` | `false`     | Lets anonymous sessions discover agents; they see only anonymous-safe ones. |

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

## Mini Apps

A Mini App is a web app you host at its own URL, shown as a page in Thunderbolt with the chat beside it. Web and desktop only.

| Variable                        | Default                                     | What it does                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MINI_APPS`                     | empty (the starter template in development) | JSON object keyed by app id. Each entry needs `name`, `origin`, and a `secret` of at least 32 characters; `description`, `icon`, and `url` (defaults to `origin`) are optional. |
| `MINI_APP_TOKEN_EXPIRY_SECONDS` | `300`                                       | Lifetime of the identity token an app is given for the signed-in user.                                                                                                          |

```bash
MINI_APPS='{"order-book":{"name":"Order Book","icon":"table","origin":"https://orders.example.com","secret":"<at least 32 characters>"}}'
```

An app appears in the sidebar as soon as it is registered. An entry that fails validation is dropped with the reason logged at startup, so that app never appears. Each app gets its own secret, so one app cannot forge another's token. Restart the API after a change. The app itself must send three headers, or it renders as a blank panel with no error: `frame-ancestors` naming your origin, `Cross-Origin-Embedder-Policy: credentialless`, and `Cross-Origin-Resource-Policy: cross-origin` ([details](../internals/architecture/mini-apps.md#the-embedding-headers)).

## Email

Sign-in codes are sent through Resend.

| Variable                    | Default                     | What it does                                                                                                                                          |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`            | none                        | Sending key. Leave it unset and no mail is sent. Fine for local evaluation, and fine on OIDC or SAML, but it breaks email-code sign-in in production. |
| `RESEND_MONITORING_API_KEY` | none                        | Separate full-access key used only by the email health check, so the sending key can stay send-only.                                                  |
| `EMAIL_FROM`                | `hello@auth.thunderbolt.io` | Sender address for outgoing mail, and the contact address in its footer.                                                                              |

Set `EMAIL_FROM` to an address on a domain your Resend account has verified: Resend rejects the default everywhere except Thunderbird's own deployment. There is no setting to use your own SMTP server.

## Browser access

| Variable                 | Default                                                          | What it does                                            |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `CORS_ORIGINS`           | `http://localhost:1420,tauri://localhost,http://tauri.localhost` | Comma-separated exact origins, no per-entry patterns.   |
| `CORS_ALLOW_CREDENTIALS` | `true`                                                           | Whether browsers may send cookies.                      |
| `CORS_ALLOW_METHODS`     | `GET,POST,PUT,DELETE,PATCH,OPTIONS`                              | Permitted HTTP methods.                                 |
| `CORS_EXPOSE_HEADERS`    | a protocol-required list                                         | Response headers the browser makes readable to the app. |

Request headers need no configuration: the API echoes back whatever the browser asks for. Override `CORS_EXPOSE_HEADERS` only to add to the default list, never to shorten it, or the app loses responses it needs to read. `CORS_ALLOW_HEADERS` is accepted but ignored, and kept only so that older configuration files keep working.

## Rate limiting

| Variable                                   | Default  | What it does                                                                                                               |
| ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`                       | `true`   | Set `false` to switch limits off. Local evaluation only.                                                                   |
| `TRUSTED_PROXY`                            | empty    | `cloudflare` trusts `CF-Connecting-IP`, `akamai` trusts `True-Client-IP`, empty trusts only the connecting socket address. |
| `ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX`         | `10`     | Anonymous sign-ins allowed per IP address per window. See [Anonymous sign-in](#anonymous-sign-in).                         |
| `ANONYMOUS_SIGN_IN_RATE_LIMIT_WINDOW_SECS` | `60`     | Length of that window, in seconds.                                                                                         |
| `CAPTCHA_PROVIDER`                         | `none`   | Captcha on anonymous sign-in. Keep `none`: the app cannot complete `altcha` yet. See [ALTCHA](#altcha).                    |
| `CAPTCHA_SECRET`                           | empty    | Key that signs ALTCHA challenges. Required with `altcha`, at least 32 characters.                                          |
| `CAPTCHA_DIFFICULTY`                       | `100000` | Upper bound of the ALTCHA search. Higher costs bots more and makes phones wait longer.                                     |
| `CAPTCHA_TTL_SECS`                         | `600`    | How long an issued ALTCHA challenge stays solvable, in seconds.                                                            |

> Don't set `TRUSTED_PROXY` unless you know exactly what sits in front of the API. Trusting the wrong header lets any client claim any IP and walk straight past the limits.

Apart from anonymous sign-in, the limits are not configurable:

| Request group                                                                    | Limit          |
| -------------------------------------------------------------------------------- | -------------- |
| Standard-tier chat responses                                                     | 60 per minute  |
| Usage receipts                                                                   | 100 per minute |
| Private chat, the bring-your-own-key relay, tools, search and previews, together | 100 per minute |
| Sign-in                                                                          | 10 per minute  |
| Debug transcript upload                                                          | 10 per hour    |

The third row is one shared bucket per user, not one per group. Authenticated requests are counted per user, anonymous accounts included, since those have a user record too. Sign-in requests have no session and are counted per IP address; when an IP cannot be determined they share a single bucket rather than skipping the limit, so that protection cannot quietly turn itself off.

Rejections return `429` with a `Retry-After` header.

### Anonymous sign-in

Anonymous sign-in has its own bucket, separate from the sign-in row above, so raising its limit never loosens waitlist join, email sign-in or the code that is emailed for it. Those keep their fixed limits because each one sends an email. The API's own limiter is the only one that counts anonymous sign-in. It keys on the client IP as resolved through `TRUSTED_PROXY`, is shared across every API instance, and uses a fixed window: the count starts at the first sign-in and resets in full when the window ends, however steady the traffic.

Whether to raise the limit depends on the captcha, which protects anonymous sign-in only:

- **With a captcha enabled**, the captcha is the bot control. You can raise the limit for venues where many people share a few public IPs (conference Wi-Fi, campus NAT), since a per-IP cap there blocks legitimate users rather than bots.
- **Without a captcha** (`CAPTCHA_PROVIDER=none`), the IP limit is the only bot control. Keep the defaults.

The API enforces this: with `AUTH_ALLOW_ANONYMOUS=true` and `CAPTCHA_PROVIDER=none`, it refuses to start if `ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX` is above 10 or `ANONYMOUS_SIGN_IN_RATE_LIMIT_WINDOW_SECS` is below 60. The `altcha` provider will lift this once the app supports it; until then an anonymous deployment keeps the defaults.

### ALTCHA

> The API supports ALTCHA, but the app does not yet. It never fetches or solves a challenge, so with `CAPTCHA_PROVIDER=altcha` every anonymous sign-in is refused with `403`. Leave `CAPTCHA_PROVIDER` unset (or `none`) until a release of the app adds ALTCHA support.

[ALTCHA](https://altcha.org) is a self-hosted proof-of-work captcha: the browser spends a moment of CPU time instead of solving a puzzle, and no third party sees the request. The API side works like this: a client fetches a challenge from `GET /v1/captcha/challenge`, solves it, and sends the result in the `X-Captcha-Token` header of the anonymous sign-in request. A missing, wrong, expired or reused solution gets `403`.

Each solution works once. Redeemed challenges are recorded in the database, so a token cannot be replayed against another API instance, and expired records are swept hourly. Generate the secret with `openssl rand -hex 32` and give every instance the same value; changing it invalidates challenges already issued.

`CAPTCHA_DIFFICULTY` is the trade-off between bot cost and user wait. A client tries half that many SHA-256 hashes on average, and the cost scales linearly for an attacker and for a low-end phone alike. Time a sign-in on the slowest phone you expect visitors to carry before raising it, and lower it if sign-in feels slow there.

The challenge route has its own per-IP bucket, sized by the same `ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX` and `ANONYMOUS_SIGN_IN_RATE_LIMIT_WINDOW_SECS`, because every anonymous sign-in needs one challenge.

## Minimum client version

| Variable          | Default | What it does                                                                                                                    |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_APP_VERSION` | empty   | Lowest app version allowed to talk to this deployment, as a semver string (`0.2.0`, or `0.2.0-rc.1`). Empty disables the check. |

Older clients receive `426 Upgrade Required` and prompt the user to update. The check fails closed: a client that sends no version is treated as too old, and a personal access token earns no exemption, so scripts and the command-line client must send a version on their API calls.

Exempt, because none of them can set the header: the startup configuration request, health checks, SSO and SAML browser callbacks, the command-line client's device-grant login, analytics capture, static assets, and the proxy WebSocket upgrade. `OPTIONS` preflights are always exempt. A blocked user can therefore still reach the update prompt.

## Command-line client rollout

`CLI_DEVICE_REGISTRATION_ENABLED`, `false` by default, allows the command-line client to register as a device.

Enable it only after every app your users run is new enough to recognise a command-line client in the device list, since an older app cannot display a kind of device it does not know about. Set `MIN_APP_VERSION` first if you cannot be sure.

## Analytics and tracing

| Variable                      | Default                    | What it does                                                                                                        |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POSTHOG_API_KEY`             | none                       | Leave unset to send no analytics. This is the off switch.                                                           |
| `POSTHOG_HOST`                | `https://us.i.posthog.com` | Point at your own PostHog instance if you run one.                                                                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none                       | OpenTelemetry trace collector endpoint, for example `http://localhost:4318/v1/traces`. Setting it turns tracing on. |
| `OTEL_EXPORTER_OTLP_TOKEN`    | none                       | Bearer token, for collectors that require one.                                                                      |

Any OTLP collector works. We test with BetterStack.

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
| `/v1/health/models`    | One tiny completion against every model offered, 30 seconds each.                            |

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

| Build argument               | Default | What it does                                                                                                                                              |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Where the app calls the API. A relative path works when a reverse proxy fronts both.                                                                      |
| `VITE_AUTH_MODE`             | `sso`   | `sso` for OIDC or SAML, anything else for email sign-in codes.                                                                                            |
| `VITE_ORG_ESCROW_PUBLIC_KEY` | empty   | Base64 P-256 public key the app wraps account keys to, for [organizational key escrow](#organizational-key-escrow). Build it in before turning escrow on. |

Several further settings are read when the app is built but are not offered as build arguments, so you can only set them by building the image yourself. Anonymous sessions need `VITE_AUTH_ENABLE_ANONYMOUS=true` **and** `VITE_BYPASS_WAITLIST=true` alongside `AUTH_ALLOW_ANONYMOUS`; with only the first two a visitor still meets the sign-in wall. `VITE_APP_VERSION` is what makes a client send `X-App-Version`, so the version gate depends on it. `VITE_IROH_RELAY_URL` points the command-line bridge at a relay of your own instead of the public ones.

## Common startup errors

| What it reports                                       | Fix                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` is empty                         | Set it. `openssl rand -hex 32`.                                                           |
| The sync signing secret is shorter than 32 characters | Generate a longer `POWERSYNC_JWT_SECRET`, and update the sync service to match.           |
| `AUTH_MODE` is not a recognised value                 | Must be `consumer`, `oidc`, or `saml`.                                                    |
| `MIN_APP_VERSION` is not a version number             | Use a semver string, for example `0.2.0`, or clear it.                                    |
| `DATABASE_URL` is required with the `postgres` driver | Set a connection string, or set `DATABASE_DRIVER=pglite` for evaluation.                  |
| The debug transcript URL and key must be set together | Set both `DEBUG_TRANSCRIPT_UPSTREAM_URL` and `DEBUG_TRANSCRIPT_UPSTREAM_KEY`, or neither. |
