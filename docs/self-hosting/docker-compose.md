# Docker Compose

The Docker Compose stack is the fastest path to a working Thunderbolt install. It's well suited to demos, evaluations, and single-host internal tools.

## Prerequisites

- Docker 24+ with the Compose plugin (`docker compose version` must succeed)
- 4 GB RAM minimum, 8 GB recommended
- Ports `3000`, `5432`, `8180` available (or edit `deploy/docker-compose.yml` to remap)

## Spin It Up

```bash
git clone https://github.com/thunderbird/thunderbolt.git
cd thunderbolt/deploy
cp .env.example .env
# Edit .env — at minimum set BETTER_AUTH_SECRET, POWERSYNC_JWT_SECRET,
# and one AI provider API key
docker compose up --build
```

The backend entrypoint runs Drizzle migrations before serving traffic, the Keycloak realm imports on first boot, and PowerSync loads its sync rules from `deploy/config/powersync-config.yaml`.

## What You Get

| Service        | URL                          | Credentials                                |
| -------------- | ---------------------------- | ------------------------------------------ |
| App            | `http://localhost:3000`      | Keycloak SSO (demo user below)             |
| Keycloak admin | `http://localhost:8180`      | `admin` / `admin` — **rotate immediately** |
| Demo user      | (sign in via app)            | `demo@thunderbolt.so` / `demo`             |

Behind the scenes, the compose file boots:

| Dockerfile                    | Base                               | Purpose                                                               |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `docker/frontend.Dockerfile`  | `oven/bun` → `nginx:alpine`        | Vite SPA with COEP/COOP headers                                       |
| `docker/backend.Dockerfile`   | `oven/bun:latest`                  | Elysia API; entrypoint runs `bun drizzle-kit migrate` before starting |
| `docker/postgres.Dockerfile`  | `postgres:18-alpine`               | PostgreSQL with PowerSync replication role (`deploy/docker/postgres-init/01-powersync.sql`) |
| `docker/keycloak.Dockerfile`  | `keycloak:26.0`                    | OIDC/SAML with the `thunderbolt` realm pre-imported                   |
| `docker/powersync.Dockerfile` | `journeyapps/powersync-service`    | PowerSync service with the synced-table rules                         |
| (official) `mongo:7.0`        | —                                  | PowerSync operational store                                           |

## Customization

- **Bring your own identity provider.** Remove the `keycloak` service from the compose file, then set the OIDC vars (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) or the SAML vars (`SAML_ENTRY_POINT`, `SAML_ISSUER`, `SAML_CERT`) in `.env` depending on your `AUTH_MODE`.
- **Use managed Postgres.** Point `DATABASE_URL` at your Postgres, remove the `postgres` service, and manually run `deploy/docker/postgres-init/01-powersync.sql` against it to create the `powersync_role` user and publication.
- **TLS.** The bundled stack serves plain HTTP. Put it behind Caddy, Traefik, or the reverse proxy of your choice — the frontend nginx expects the upstream to terminate TLS.

## Upgrading

```bash
cd thunderbolt
git pull
cd deploy
docker compose pull
docker compose up -d --build
```

The backend entrypoint applies pending migrations on start. PowerSync reloads sync rules from `config.yaml`.

## Tearing Down

```bash
docker compose down        # stop, keep data
docker compose down -v     # stop + wipe Postgres, Mongo, and Keycloak data
```
