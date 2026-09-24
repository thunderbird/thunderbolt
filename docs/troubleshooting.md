# Troubleshooting

## Check these first

Three checks account for most problems. `curl https://your-host/v1/health` needs no credentials and returns `200` quickly when the API is up. `curl https://your-host/v1/config` is unauthenticated JSON showing what the apps see: whether encryption is on, whether the built-in and custom agents are allowed, the minimum app version you enforce, and the model catalog you ship. `GET /v1/agents` lists the agents themselves.

The server logs name the setting behind every startup failure. The command to follow them depends on the deployment:

```bash
docker compose logs -f backend                    # Docker Compose
kubectl logs -n thunderbolt deploy/backend        # Kubernetes
```

Deeper probes exist for the database, sync, email, and every configured model. They need `MONITORING_TOKEN` set on the server:

```bash
curl -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/database
curl -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/powersync
curl -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/email
curl -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/models
```

The email probe needs a second setting of its own, `RESEND_MONITORING_API_KEY`. It is separate from the key used to send mail because the probe asks the email provider which sending domains are verified, which the sending key is not entitled to do. Without it the probe reports `not-configured` even on a deployment that sends mail perfectly well.

Settings are read once, at startup, so restart the server after changing any environment variable.

## The deployment will not start

Every setting is validated on boot, and a value the server rejects stops startup with the name of the offending variable.

| Message                                                                          | Fix                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `betterAuthSecret: Invalid input: expected string, received undefined`           | `BETTER_AUTH_SECRET` is unset. Generate one with `openssl rand -hex 32`. |
| `DATABASE_URL is required when DATABASE_DRIVER=postgres (outside development)`   | Set a connection string, or `DATABASE_DRIVER=pglite` for evaluation.     |
| `powersyncJwtSecret must be at least 32 characters when powersyncUrl is set`     | Generate a longer secret and update the sync service to match.           |
| `authMode: Invalid option: expected one of "consumer"\|"oidc"\|"saml"`           | `AUTH_MODE` is misspelled. Use one of those three values.                |
| `MIN_APP_VERSION must be empty or a semver string (e.g. "0.2.0")`                | Use a semver string such as `0.2.0`, or clear it.                        |
| `debugTranscriptUpstreamUrl and debugTranscriptUpstreamKey must be set together` | Set both, or neither.                                                    |

Some messages name the setting in mixed case instead of as the environment variable you set: `betterAuthSecret` is `BETTER_AUTH_SECRET`, `powersyncJwtSecret` is `POWERSYNC_JWT_SECRET`. Split it at each capital letter and upper-case the result.

Single sign-on adds its own required sets, and a missing member of either one stops startup with a message naming all of them:

- With `AUTH_MODE=oidc`: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`.
- With `AUTH_MODE=saml`: `SAML_ENTRY_POINT`, `SAML_CERT`, `SAML_ENTITY_ID`, `SAML_IDP_ISSUER`.

### Other startup failures

| Symptom                                                            | Cause and fix                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose exits immediately complaining about `BETTER_AUTH_SECRET`   | Unset in `deploy/.env`. Set it and retry. There is no default, deliberately.                                                                                                                                           |
| `port is already allocated`                                        | Remap it in `deploy/.env` (`FRONTEND_PORT`, `BACKEND_PORT`, `POSTGRES_PORT`, `POWERSYNC_PORT`, `KEYCLOAK_PORT`). Port `5434` collides most often; without a `deploy/.env` the compose fallbacks are `5433` and `8080`. |
| The sync container restarts in a loop after an upgrade or re-clone | Its database account is created only when the database volume is first initialised, so an older volume does not have it. `docker compose down -v` starts clean and erases data.                                        |
| The image build fails on a small machine                           | The app build is the memory-hungry step. Give Docker at least 4 GB.                                                                                                                                                    |
| On Kubernetes, `backend` and `powersync` restart once or twice     | Expected on first install. They race PostgreSQL and recover once it accepts connections. End state is every pod `1/1 Running`.                                                                                         |
| Sign-in pages will not load right after startup                    | The bundled Keycloak is the slowest service to boot. Wait for it to report healthy.                                                                                                                                    |

## Users cannot sign in

### Emailed sign-in codes (consumer mode)

Check the waitlist gate first. An address with no existing account and no approved waitlist entry receives a "you're on the list" email instead of a sign-in code, regardless of `WAITLIST_ENABLED`. Set `WAITLIST_AUTO_APPROVE_DOMAINS` to your own domains, or nobody new can sign in.

```bash
WAITLIST_AUTO_APPROVE_DOMAINS=example.com,example.org
```

| Symptom                                                             | Likely cause                                                                                       | Check                                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No email arrives at all                                             | `RESEND_API_KEY` is unset, so nothing is sent                                                      | The log warns at startup when the key is missing. `/v1/health/email` confirms the sending domain is verified, once `RESEND_MONITORING_API_KEY` is also set |
| A waitlist email arrives instead of a code                          | The waitlist gate above                                                                            | Add the domain to `WAITLIST_AUTO_APPROVE_DOMAINS` and restart                                                                                              |
| "This code has expired" or "Invalid code"                           | The code timed out or was mistyped                                                                 | Request a new one                                                                                                                                          |
| "Too many attempts"                                                 | Repeated wrong codes                                                                               | Request a new code                                                                                                                                         |
| `429` on a sign-in request                                          | Either of two limits: 10 requests per minute per IP, or a 15 second per-address cooldown on resend | Wait out `Retry-After` where it is sent. The resend cooldown returns `code_already_sent` with no header                                                    |
| The sign-in link opens the wrong host                               | `APP_URL` or `BETTER_AUTH_URL` does not match the public URL                                       | Set both to the URLs users actually reach, then restart                                                                                                    |
| Sign-in fails only in the browser, with a console CORS error        | The app origin is not in `CORS_ORIGINS`                                                            | Add the exact origin. Wildcards are not accepted                                                                                                           |
| Connecting a Google or Microsoft account from the desktop app fails | The loopback redirect URIs are not registered                                                      | Register `http://localhost:17421`, `:17422`, and `:17423` with the provider. The same ports serve the desktop SSO callback                                 |
| Anonymous use is rejected                                           | `AUTH_ALLOW_ANONYMOUS` is `false`, and the client build must agree                                 | Set it on the server and build the client with `VITE_AUTH_ENABLE_ANONYMOUS`                                                                                |

### When the app itself is broken

Serve the app over HTTPS anywhere other than `localhost`. Browsers grant the local-database and isolation capabilities Thunderbolt depends on only to secure origins, so a plain-HTTP hostname produces a broken app rather than an insecure one.

## Single sign-on fails

| Symptom                                                  | Cause                                                                                      | Fix                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| The app loads normally and never redirects to the IdP    | The client was not built for SSO                                                           | Build the web client with `VITE_AUTH_MODE=sso`                                                   |
| The app loads normally and never redirects to the IdP    | A stale session from a previous sign-in                                                    | Clear site data for the app origin and reload                                                    |
| `discovery_untrusted_origin`                             | The IdP origin is missing from `TRUSTED_ORIGINS`                                           | Add it there, not to `CORS_ORIGINS`, and restart                                                 |
| `discovery_unexpected_error`                             | The server cannot reach the identity provider                                              | Confirm the provider is running and reachable from the server's network                          |
| Discovery succeeds but tokens are rejected in containers | The server reaches the IdP on an internal hostname while tokens carry a browser-facing one | Set `OIDC_DISCOVERY_URL` to the internal URL and list both origins in `TRUSTED_ORIGINS`          |
| OIDC callback returns `404` or `redirect_uri` mismatch   | The redirect URI registered with the provider is wrong                                     | Register `https://your-backend/v1/api/auth/sso/callback/sso`                                     |
| SAML sign-in is rejected on the way back                 | The assertion consumer service (ACS) URL registered with the provider is wrong             | Register `https://your-backend/v1/api/auth/sso/saml2/sp/acs/sso`                                 |
| `Invalid certificate`                                    | `SAML_CERT` includes PEM headers or line breaks                                            | Paste the raw base64 only, without `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` |
| The IdP rejects the entity ID                            | `SAML_ENTITY_ID` does not match the application registered in the IdP                      | Make them identical                                                                              |

Point your IdP at the service-provider metadata to check what Thunderbolt is actually sending:

```
https://your-backend/v1/api/auth/sso/saml2/sp/metadata?providerId=sso
```

Two behaviours that are not faults:

- **Signing out puts the user straight back in.** The identity provider keeps its own session, so the next visit re-authenticates silently. This is normal SSO behaviour and Thunderbolt cannot end the provider's session for you.
- **The bundled Keycloak forgets its configuration.** In every bundled deployment it runs in development mode with no persistent storage, so anything set in its admin console is lost when the container or pod restarts and the realm is re-imported. Don't use it past evaluation.

## Chats are not syncing between devices

Work down this list in order. Most reports are the first item.

**1. Sync needs a signed-in account** (anonymous sessions cannot sync). Signing in turns it on automatically, but check **Settings → Preferences → Data → Sync This Device With Cloud** is still on, on every device.

**2. The server has no sync configured.** `POWERSYNC_URL` and `POWERSYNC_JWT_SECRET` must both be set. Without them the app works on one device at a time.

**3. The secret does not match.** The backend and the sync service must hold the same signing secret, and the same key identifier if you set `POWERSYNC_JWT_KID`. Generate it base64url: a value containing `+`, `/`, or `=` is rejected by the sync service.

```bash
openssl rand 32 | basenc --base64url --wrap=0
```

**4. The browser cannot reach the sync service.** Devices connect to it directly, not through the API. Confirm the `/powersync/` path is routed, or that the sync port is reachable from the browser and not only from inside Docker.

**5. The database is not set up for replication.**

| Requirement                                             | Note                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Logical replication (`wal_level = logical`)             | A parameter-group change on managed databases, and it needs a restart  |
| A replication login and a publication named `powersync` | Created automatically on the bundled database's first boot only        |
| A second `powersync_storage` database                   | On the same server                                                     |
| `DATABASE_DRIVER=postgres`                              | The embedded `pglite` driver cannot replicate, so sync is off entirely |

**6. With encryption on, the device is waiting for approval.** A new device registers as pending and shows an approval screen. Approve it from an already trusted device under **Settings → Devices**, or enter the 24-word recovery phrase. With every trusted device lost and no recovery phrase, the encrypted history cannot be recovered, by the user or by you. An account is limited to 10 active devices; revoke one under **Settings → Devices** to free a slot.

Once those are settled, confirm the sync service is alive with `/v1/health/powersync`.

### Syncing, but something is missing

| What is missing                                                                                 | Why                                                                              |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Model API keys, tool servers and their credentials, connected-account tokens, agent credentials | Credentials never sync. Enter them once per device, by design                    |
| File attachments                                                                                | The filename travels with the message, the bytes do not                          |
| One device's recent changes                                                                     | It has not reconnected. **Settings → Devices** shows a last seen time per device |
| An edit made on two devices at once                                                             | The most recent write wins for that record                                       |

Rotating `POWERSYNC_JWT_SECRET` invalidates every outstanding sync token, so every device reconnects. Expect a brief gap after a rotation.

## A model returns an error

| What the user sees                       | Meaning                                                                                                                                   | Fix                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No models in the picker                  | No provider key on the server and none added in the app                                                                                   | Set a provider key, or have users add their own in **Settings → Models**                                                       |
| `429` with `INFERENCE_QUOTA_EXCEEDED`    | The user hit a spending cap, not a request limit                                                                                          | Raise the relevant `INFERENCE_QUOTA_*` value. Caps are rolling 5 hour and 7 day windows, and much lower for anonymous sessions |
| `429` reading "Too many requests"        | The request rate limit: 60 per minute for standard-tier inference, 100 shared between private chat, the proxy, tools, search and previews | Wait, or investigate a client retry loop                                                                                       |
| `503` with `INFERENCE_PRICE_UNAVAILABLE` | The model has no price entry, so the server refuses to serve it                                                                           | Use one of the shipped models. A model with no price is unusable rather than free                                              |
| `503 Tinfoil provider not configured`    | `TINFOIL_API_KEY` is unset, and the confidential models are the default                                                                   | Set the key, or have users select a model they hold a key for                                                                  |
| `403 WEB_LOGIN_REQUIRED`                 | A personal access token was used against a confidential model                                                                             | Sign in interactively, or set `CONFIDENTIAL_API_KEYS_ENABLED=true`                                                             |
| `426 Upgrade Required`                   | The client is older than `MIN_APP_VERSION`                                                                                                | See [the desktop app will not update](#the-desktop-app-will-not-update)                                                        |
| Timeouts reaching the provider           | Outbound network access is blocked                                                                                                        | Allow the provider host from the server                                                                                        |

The four spending caps are `INFERENCE_QUOTA_REGISTERED_5H_CENTS` (default 1500, so $15), `INFERENCE_QUOTA_REGISTERED_7D_CENTS` (7500), `INFERENCE_QUOTA_ANONYMOUS_5H_CENTS` (10) and `INFERENCE_QUOTA_ANONYMOUS_7D_CENTS` (60). All four are whole cents.

A model that fails only for one user is almost always their own key or endpoint. **Settings → Models** has a Test Connection button for every provider except the deployment's own managed models, which have nothing to verify.

### Confirm every model end to end

```bash
curl -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/models
```

This sends one tiny completion to each model in the catalog and reports `not-configured`, `missing-price`, `timeout`, `upstream-error`, or `no-text` per model. Don't poll it more often than every 15 minutes: every call spends real money.

### Egress allowlists

Two paths reach hosts you cannot list in advance. First, a user's own provider key, or a tool server they connect over MCP (the Model Context Protocol, the open standard Thunderbolt uses to plug in external tools): those calls are relayed through your server, because a browser cannot make them directly. Second, link previews, which fetch whatever page a user pasted. A strict outbound allowlist breaks both.

## Attachments fail

Images and PDFs are compressed before the size check, so a large photo often fits after shrinking.

| Symptom                                                          | Cause                                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The file is rejected on drop or paste                            | Unsupported type. PDF, PNG, JPEG, WebP, GIF, DOCX, XLSX, Markdown, plain text, CSV, and JSON are accepted               |
| "File too large"                                                 | The cap is 25 MB per file after compression, and 10 files per message                                                   |
| "This model couldn't read the attached file"                     | Thunderbolt already retried: native file, then extracted text, then page images. The model cannot read it in any form   |
| A scanned PDF comes back as gibberish or empty                   | There is no text recognition for scanned pages. They are sent as page images, so this needs a model that can see images |
| An image is rejected with no retry                               | Images have no conversion path. A model that cannot accept images fails immediately                                     |
| The attachment is gone when the chat is opened on another device | Attachment contents never sync. Open the chat on the device that sent it                                                |
| The attachment is missing from a data export                     | Exports carry the reference, not the file                                                                               |

> Attachment contents live in the browser's storage for the app origin. Clearing site data removes them from messages that have already been sent.

## Voice does not work

| Symptom                                                 | Cause and fix                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No voice button in the composer                         | It only replaces the send button when the composer is empty and idle. Clear any typed text                              |
| Nothing happens, or an error about the microphone       | Microphone permission was denied in the browser, or for the app in the operating system's privacy settings              |
| The microphone is unavailable on a plain HTTP host      | Browsers expose microphones to secure origins only. Use HTTPS, or `localhost`                                           |
| `503 Tinfoil provider not configured`                   | The hosted speech engine needs `TINFOIL_API_KEY` on the server. Without it, use a custom speech server (below)          |
| A custom speech server never connects                   | Its CORS policy must allow the origin the app is served from. This is the most common cause                             |
| A custom speech server on `http://localhost` is blocked | Browsers block mixed content from an HTTPS page. Use the desktop app, run the app locally, or put the server behind TLS |
| A custom speech server returns 404                      | The base URL must include the version prefix, for example `http://localhost:8880/v1`                                    |
| Your turn never ends                                    | About 1.4 seconds of silence commits a turn. Pause fully                                                                |
| The assistant interrupts itself                         | It is hearing its own output. Use headphones, or move away from the speakers                                            |

Custom speech servers are a preview feature: turn on **Custom voice provider** under **Settings → Preferences → Help Thunderbolt Improve**, in Preview Features, then configure it under **Settings → Voice**. The provider configuration is per device and is not synced, and a change takes effect on the next voice session.

## The desktop app will not update

Updates are checked and applied from **Settings → Preferences**, in the App Version section.

| Symptom                                                 | Cause and fix                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "Couldn't check for updates"                            | The app cannot reach the update service. Allow `cdn.crabnebula.app` from the client network                             |
| No update is ever found on a build you made yourself    | Only the official builds ship with an update feed and signing key. Distribute new installers to your users yourself     |
| "Couldn't download the update"                          | A network interruption, or no permission to write to the install location. Retry, then reinstall from the release page  |
| The new version is not running after a restart          | The restart step did not complete. Quit the app fully and reopen it                                                     |
| Tapping **Check for updates** on mobile opens the store | Mobile updates come from TestFlight or Google Play, so the button opens the store listing rather than updating in place |

### "Update required" blocks the whole app

The server rejects clients older than `MIN_APP_VERSION`. The screen the user sees offers the update flow directly on desktop, and a reload on the web once you have deployed a newer app build.

The check fails closed: a client that sends no version is treated as too old. If a valid, current client is being blocked, verify `MIN_APP_VERSION` is what you intended and restart the server after changing it.

## Getting help

- Open an issue at [github.com/thunderbird/thunderbolt](https://github.com/thunderbird/thunderbolt/issues) with your deployment target, the app version from **Settings → Preferences**, and the relevant server log lines.
- Sending a debug transcript is an option only if your deployment is configured for it. See the [configuration reference](./self-hosting/configuration.md).

> Understand what a transcript contains before you enable forwarding: the full conversation plus the user ID and email your deployment holds, sent to and retained by the Thunderbolt team.
