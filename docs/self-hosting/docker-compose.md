# Docker Compose

Fastest path to a working Thunderbolt install: demos, evaluations, single-host internal tools.

## Prerequisites

- Docker 24+ with the Compose plugin (`docker compose version` must succeed)
- 4 GB RAM minimum, 8 GB recommended
- Ports `3000`, `8000`, `5434`, `8081`, `8180` free, or remap via `FRONTEND_PORT`, `BACKEND_PORT`, `POSTGRES_PORT`, `POWERSYNC_PORT`, `KEYCLOAK_PORT` in `deploy/.env`

## Spin It Up

```bash
git clone https://github.com/thunderbird/thunderbolt.git
cd thunderbolt/deploy
cp .env.example .env
# In .env, set at minimum BETTER_AUTH_SECRET (generate with
# `openssl rand -base64 32`) and one AI provider API key.
# POWERSYNC_JWT_SECRET is hardcoded in docker-compose.yml; override
# only if you fork the compose file.
docker compose up --build
```

## What You Get

| Service        | URL                     | Credentials                            |
| -------------- | ----------------------- | -------------------------------------- |
| App            | `http://localhost:3000` | Keycloak SSO (demo user below)         |
| Keycloak admin | `http://localhost:8180` | `admin` / `admin` (rotate immediately) |
| Demo user      | (sign in via app)       | `demo@thunderbolt.io` / `demo`         |

| Service   | Source                                 | Notes                                                                                                                                    |
| --------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend  | built, `docker/frontend.Dockerfile`    | `oven/bun:1.3.14` build stage → `nginxinc/nginx-unprivileged:alpine`; Vite SPA with COEP/COOP headers                                    |
| Backend   | built, `docker/backend.Dockerfile`     | `oven/bun:1.3.14`; entrypoint runs `bun drizzle-kit migrate` before starting Elysia                                                      |
| Postgres  | `postgres:17-alpine`                   | `deploy/docker/postgres-init/01-powersync.sh` creates the PowerSync replication role on first init                                       |
| PowerSync | `journeyapps/powersync-service:latest` | Sync rules bind-mounted from `deploy/config/powersync-config.yaml`; bucket data lives in the `powersync_storage` DB on the same Postgres |
| Keycloak  | `quay.io/keycloak/keycloak:26.0`       | `start-dev --import-realm` against `deploy/config/keycloak-realm.json`                                                                   |

**The Postgres 17 pin is load-bearing.** Compose mounts `pg_data:/var/lib/postgresql/data` (`deploy/docker-compose.yml:75`), the v17 default path. `postgres:18` and later want the volume one level up at `/var/lib/postgresql` (they manage a version subdirectory inside it) and refuse to start against a mount at the old path. The local dev stack (`make up`) moved its mount instead (`powersync-service/docker-compose.yml:25-29`).

## Unused Dockerfiles

`deploy/docker/` holds four more Dockerfiles, unused by compose. The first three bake config into an upstream base image and are published to GHCR by `.github/workflows/images-publish.yml`.

| Dockerfile             | Base                             | Built and deployed by                       |
| ---------------------- | -------------------------------- | ------------------------------------------- |
| `postgres.Dockerfile`  | `postgres:18-alpine`             | GHCR (`images-publish.yml:130`), Pulumi EKS |
| `keycloak.Dockerfile`  | `quay.io/keycloak/keycloak:26.7` | GHCR (`images-publish.yml:143`), Pulumi EKS |
| `powersync.Dockerfile` | `journeyapps/powersync-service`  | GHCR (`images-publish.yml:156`), Pulumi EKS |
| `marketing.Dockerfile` | Astro marketing site             | nothing in compose                          |

Pulumi deploys the GHCR builds (`deploy/pulumi/src/eks.ts:135-143`, `deploy/pulumi/src/shared.ts:408`) and pins `PGDATA` on the Fargate task, so EFS volumes predating the v17→v18 bump keep the legacy layout (`deploy/pulumi/src/services.ts:217-222`). The Helm chart instead defaults Postgres, PowerSync and Keycloak to upstream images (`deploy/k8s/values.yaml:93-95`, `:117-120`, `:149-152`), which the Pulumi EKS path overrides.

## Customization

- **Own identity provider.** Remove the `keycloak` service and set, per your `AUTH_MODE`, either the OIDC vars (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) or the SAML vars (`SAML_ENTRY_POINT`, `SAML_ENTITY_ID`, `SAML_IDP_ISSUER`, `SAML_CERT`) in `.env`.
- **Managed Postgres.** Point `DATABASE_URL` at it, remove the `postgres` service, and run `deploy/docker/postgres-init/01-powersync.sh` against it by hand to create the `powersync_role` user and publication.
- **TLS.** The stack serves plain HTTP; the frontend nginx expects an upstream reverse proxy (Caddy, Traefik) to terminate TLS.

## Upgrading

```bash
cd thunderbolt
git pull
cd deploy
docker compose pull
docker compose up -d --build
```

Migrations apply on backend start; PowerSync re-reads its bind-mounted sync rules on restart.

## Tearing Down

```bash
docker compose down        # stop and remove containers, keep the pg_data volume
docker compose down -v     # also drop pg_data: app data and PowerSync bucket storage
```
