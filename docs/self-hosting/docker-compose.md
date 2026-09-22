# Docker Compose

The Docker Compose stack is the fastest path to a working Thunderbolt install. It's well suited to demos, evaluations, and single-host internal tools.

## Prerequisites

- Docker 24+ with the Compose plugin (`docker compose version` must succeed)
- 4 GB RAM minimum, 8 GB recommended
- Ports `3000`, `8000`, `5434`, `8081`, `8180` available (or edit `deploy/.env` to remap — `FRONTEND_PORT`, `BACKEND_PORT`, `POSTGRES_PORT`, `POWERSYNC_PORT`, `KEYCLOAK_PORT`)

## Spin It Up

```bash
git clone https://github.com/thunderbird/thunderbolt.git
cd thunderbolt/deploy
cp .env.example .env
# Edit .env — at minimum set BETTER_AUTH_SECRET (generate with
# `openssl rand -base64 32`) and one AI provider API key.
# Note: POWERSYNC_JWT_SECRET is hardcoded in docker-compose.yml; override
# only if you fork the compose file.
docker compose up --build
```

The backend entrypoint runs Drizzle migrations before serving traffic, the Keycloak realm imports on first boot, and PowerSync loads its sync rules from `deploy/config/powersync-config.yaml`.

## What You Get

| Service        | URL                     | Credentials                                |
| -------------- | ----------------------- | ------------------------------------------ |
| App            | `http://localhost:3000` | Keycloak SSO (demo user below)             |
| Keycloak admin | `http://localhost:8180` | `admin` / `admin` — **rotate immediately** |
| Demo user      | (sign in via app)       | `demo@thunderbolt.io` / `demo`             |

Behind the scenes, compose builds two of the five services from Dockerfiles in `deploy/docker/` and pulls the other three as upstream images:

| Service   | Source                                 | Notes                                                                                                                                    |
| --------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend  | built, `docker/frontend.Dockerfile`    | `oven/bun:1.3.14` build stage → `nginxinc/nginx-unprivileged:alpine`; Vite SPA with COEP/COOP headers                                    |
| Backend   | built, `docker/backend.Dockerfile`     | `oven/bun:1.3.14`; the entrypoint runs `bun drizzle-kit migrate` before starting Elysia                                                  |
| Postgres  | `postgres:17-alpine`                   | `deploy/docker/postgres-init/01-powersync.sh` creates the PowerSync replication role on first init                                       |
| PowerSync | `journeyapps/powersync-service:latest` | Sync rules bind-mounted from `deploy/config/powersync-config.yaml`; bucket data lives in the `powersync_storage` DB on the same Postgres |
| Keycloak  | `quay.io/keycloak/keycloak:26.0`       | `start-dev --import-realm` against `deploy/config/keycloak-realm.json`                                                                   |

The Postgres pin is load-bearing. Compose mounts `pg_data:/var/lib/postgresql/data` (`deploy/docker-compose.yml:75`), the Postgres 17 default path. `postgres:18` and later expect the volume one level up at `/var/lib/postgresql` — the image manages a version-specific subdirectory inside it — and refuse to start when they find a mount at the old path. The local dev stack (`make up`, `powersync-service/docker-compose.yml:25-29`) moved its mount rather than stay on 17.

The other Dockerfiles in `deploy/docker/` are unused by compose. `postgres.Dockerfile` (`postgres:18-alpine`), `keycloak.Dockerfile` (`quay.io/keycloak/keycloak:26.7`) and `powersync.Dockerfile` bake the config files into their upstream base images; `.github/workflows/images-publish.yml` publishes all three to GHCR (lines 130, 143 and 156), and the AWS Pulumi stack deploys them (`deploy/pulumi/src/eks.ts:135-143`, `deploy/pulumi/src/shared.ts:408`). That is why the Fargate task definition pins `PGDATA`: it keeps EFS volumes created before the v17→v18 image bump resolving to the legacy on-disk layout (`deploy/pulumi/src/services.ts:217-222`). `marketing.Dockerfile` builds the Astro site and likewise has no compose service. The Helm chart takes a third path, defaulting Postgres, PowerSync and Keycloak to upstream images (`deploy/k8s/values.yaml:93-95`, `:117-120`, `:149-152`) that the Pulumi EKS path then overrides with the GHCR builds.

## Customization

- **Bring your own identity provider.** Remove the `keycloak` service from the compose file, then set the OIDC vars (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) or the SAML vars (`SAML_ENTRY_POINT`, `SAML_ENTITY_ID`, `SAML_IDP_ISSUER`, `SAML_CERT`) in `.env` depending on your `AUTH_MODE`.
- **Use managed Postgres.** Point `DATABASE_URL` at your Postgres, remove the `postgres` service, and manually run `deploy/docker/postgres-init/01-powersync.sh` against it to create the `powersync_role` user and publication.
- **TLS.** The bundled stack serves plain HTTP. Put it behind Caddy, Traefik, or the reverse proxy of your choice — the frontend nginx expects the upstream to terminate TLS.

## Upgrading

```bash
cd thunderbolt
git pull
cd deploy
docker compose pull
docker compose up -d --build
```

The backend entrypoint applies pending migrations on start. The PowerSync container re-reads its sync rules from the bind-mounted `deploy/config/powersync-config.yaml` on restart.

## Tearing Down

```bash
docker compose down        # stop and remove containers, keep the pg_data volume
docker compose down -v     # also drop pg_data — app data and PowerSync bucket storage
```
