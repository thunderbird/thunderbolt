# Docker Compose

The fastest way to get a working Thunderbolt on one machine. One command brings up five containers, and there is no cluster or cloud account involved. Each service runs as a single copy with no redundancy, so this is not a highly available deployment.

## Before you start

| You need                     | Notes                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Docker 24 or newer           | With the Compose plugin. `docker compose version` must succeed.               |
| 4 GB RAM free                | 8 GB is comfortable. The first build is CPU heavy and takes several minutes.  |
| Five free ports              | `3000`, `8000`, `8180`, `5434`, `8081`. All are remappable, see below.        |
| A session secret             | A random string, 32 characters or more. There is no default, on purpose.      |
| Access to at least one model | A provider key set here, or a key each user adds in the app after signing in. |

## Start it

```bash
git clone https://github.com/thunderbird/thunderbolt.git
cd thunderbolt/deploy
cp .env.example .env
```

Open `deploy/.env` and set `BETTER_AUTH_SECRET`; Compose refuses to start while it is empty. Generate one with:

```bash
openssl rand -base64 32
```

Then bring the stack up:

```bash
docker compose up --build
```

The first run builds the app and API images, pulls the other three, starts PostgreSQL, imports the Keycloak sign-in configuration, and applies database migrations before the API accepts traffic. Later runs start in seconds.

## Sign in

| What           | Where                   | Credentials                    |
| -------------- | ----------------------- | ------------------------------ |
| The app        | `http://localhost:3000` | `demo@thunderbolt.io` / `demo` |
| Keycloak admin | `http://localhost:8180` | `admin` / `admin`              |

Both sets of credentials are published in this repository. So are four more that `deploy/.env` cannot override, because they live in `deploy/docker-compose.yml`: the OIDC client secret, the `POWERSYNC_JWT_SECRET` and `PS_JWT_KEY_BASE64` pair the sync service verifies against, the PostgreSQL superuser password, and the `powersync_role` replication password, which appears in three places in that file. PostgreSQL is published on a host port, so its password is a live credential rather than an internal one.

> Before anyone outside your machine can reach the deployment, create your own user, rotate the Keycloak admin password, and rotate all four compose-file credentials, changing both halves of the JWT pair together and all three copies of the replication password.

## What is running

| Container   | Port   | What it does                                                                             |
| ----------- | ------ | ---------------------------------------------------------------------------------------- |
| `frontend`  | `3000` | Serves the app and forwards API calls to the backend. This is the address users open.    |
| `backend`   | `8000` | The API. Sign-in, sync tokens, and outbound calls to AI providers.                       |
| `postgres`  | `5434` | Accounts, sessions, and the server-side copy of synced data.                             |
| `powersync` | `8081` | Streams data changes to every signed-in device.                                          |
| `keycloak`  | `8180` | The bundled identity provider, preloaded with a sign-in configuration and the demo user. |

Users open port `3000`, but their browser also talks to ports `8180` and `8081` directly: sign-in redirects to Keycloak, and the app opens its own connection to the sync service. All three must be reachable from wherever the browser runs. Port `8000` is published for convenience only, since the app reaches the API through port `3000`.

To change a port, edit `FRONTEND_PORT`, `BACKEND_PORT`, `POSTGRES_PORT`, `POWERSYNC_PORT` or `KEYCLOAK_PORT` in `deploy/.env` and restart. The rest of the stack follows automatically.

Data lives in a single Docker volume that `docker volume ls` lists as `deploy_pg_data`, and nothing is written outside Docker.

## Add a model provider

Users can add their own provider keys in the app, so the stack is usable without any server-side key. To make a provider available to everyone, set its key in `deploy/.env` and restart:

```bash
ANTHROPIC_API_KEY=
FIREWORKS_API_KEY=
EXA_API_KEY=
```

`EXA_API_KEY` enables web search rather than a chat model. The [Configuration](./configuration.md) page lists every provider setting.

## Verify it works

```bash
docker compose ps                        # every service up, postgres and keycloak healthy
curl http://localhost:3000/v1/config     # returns JSON, no sign-in needed
docker compose logs -f backend           # "Running database migrations", then "Starting server"
```

The `curl` goes through the app's own address, so a JSON reply means the browser-facing service and the API behind it are both answering. Sign in as the demo user and open the same conversation in a second browser window: if it appears there too, sync is working as well.

## First-run problems

| Symptom                                                            | Cause and fix                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose exits immediately complaining about `BETTER_AUTH_SECRET`   | It is unset in `deploy/.env`. Set it and retry.                                                                                                                                                       |
| A port is already allocated                                        | Pick a free number in `deploy/.env` and restart.                                                                                                                                                      |
| The app loads but the first sign-in fails or returns an error      | The API is still applying migrations on first boot. Watch `docker compose logs -f backend` for "Starting server", then retry.                                                                         |
| Sign-in redirects to a page that will not load                     | Keycloak is still starting. It is the slowest service on first boot. Wait for `docker compose ps` to report it healthy.                                                                               |
| The sync service restarts in a loop after an upgrade or a re-clone | Its database account is created only when the PostgreSQL volume is first initialised, so a volume from an older run will not have it. Run `docker compose down -v` to start clean, which erases data. |
| The app loads but data never syncs between two windows             | The browser must reach the sync service directly. Check that `POWERSYNC_PORT` is reachable from the browser, not only from inside Docker.                                                             |
| No models appear in the model picker                               | No provider key is set on the server and none has been added in the app. Add one of either.                                                                                                           |
| The build fails on a machine with less than 4 GB RAM               | The app build is the memory-hungry step. Raise Docker's memory limit in Docker Desktop's settings.                                                                                                    |

## Known limits of this setup

**It assumes `localhost`.** Sign-in URLs, the API origin and the sync address are all written as `localhost` addresses. Serving this stack to other machines under a real hostname means editing those addresses in `deploy/docker-compose.yml`, not only the port settings in `deploy/.env`. For a shared deployment we recommend Kubernetes or AWS instead.

**There is no TLS.** Everything is plain HTTP. Don't let this stack leave your machine without a reverse proxy such as Caddy, nginx or Traefik in front of it. Browsers grant the local-database and isolation capabilities the app depends on only to secure origins, which means `localhost` or HTTPS and nothing in between, so a plain-HTTP hostname produces a broken app rather than an insecure one.

**Rate limiting is off** and Keycloak runs in its development mode. Don't put this stack in front of real users.

**PostgreSQL 17 is pinned.** The bundled database is version 17 and its data volume is mounted at the path version 17 expects. Don't swap the image for 18 or later: PostgreSQL 18 moved that path, so it refuses to start against an existing volume.

## Swap in your own pieces

Both swaps below mean editing `deploy/docker-compose.yml` directly. The settings involved are written into that file rather than read from `deploy/.env`, so changing them in `.env` alone has no effect.

**Your own identity provider.** Remove the `keycloak` service, and the backend's dependency on it, from `deploy/docker-compose.yml`. Then replace the bundled OIDC values in the backend's settings with your own. For OpenID Connect (OIDC) set `AUTH_MODE` to `oidc` plus `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`; for SAML set `AUTH_MODE` to `saml` plus `SAML_ENTRY_POINT`, `SAML_ENTITY_ID`, `SAML_IDP_ISSUER` and `SAML_CERT`. Add your provider's origin to `TRUSTED_ORIGINS`. The [Configuration](./configuration.md) page documents each of these.

**Managed PostgreSQL.** Point `DATABASE_URL` and the sync service's two connection strings at it, then remove the `postgres` service. The bundled database is prepared for replication on first boot and a managed one is not, so before switching you must set it up by hand: enable logical replication (`wal_level=logical`), create a role named `powersync_role` with the `REPLICATION` and `BYPASSRLS` attributes, create a publication named `powersync` covering all tables, and create a second database named `powersync_storage` for the sync service's own bookkeeping. `deploy/docker/postgres-init/01-powersync.sh` is the script that does all of this on the bundled database; run it against the managed one by hand. Don't put `powersync_storage` on managed PostgreSQL 17. The [self-hosting overview](./README.md) has the detail.

## Upgrade

```bash
cd thunderbolt
git pull
cd deploy
docker compose pull            # refreshes PostgreSQL, the sync service and Keycloak
docker compose up -d --build
```

Database migrations run automatically when the API starts, sync configuration is re-read on restart, and your data is preserved. See [Upgrading](./upgrading.md) for version-specific notes.

## Stop and remove

```bash
docker compose down      # stop the containers, keep all data
docker compose down -v   # also delete the database volume, losing everything
```

> `down -v` erases every account, conversation and setting on the server. Take a [backup](./backup-and-restore.md) first.

## Next

- [Configuration](./configuration.md): every setting and environment variable, with defaults.
- [Backup and restore](./backup-and-restore.md): what to copy, and how to bring it back.
- [Monitoring](./monitoring.md): health endpoints, logs, and metrics.
