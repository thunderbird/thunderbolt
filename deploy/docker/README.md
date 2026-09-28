# Dockerfiles

Shared Docker images used by all deployment targets (docker-compose, k8s, Fargate).

## Images

| Dockerfile             | Base                                                     | Purpose                                                |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `backend.Dockerfile`   | `oven/bun:1.3.14`                                        | Bun API server with Drizzle migration entrypoint       |
| `frontend.Dockerfile`  | `oven/bun:1.3.14` → `nginxinc/nginx-unprivileged:alpine` | Vite SPA build, served by nginx with COEP/COOP headers |
| `postgres.Dockerfile`  | `postgres:18-alpine`                                     | PostgreSQL with PowerSync replication role init        |
| `keycloak.Dockerfile`  | `quay.io/keycloak/keycloak:26.7`                         | Keycloak with enterprise realm auto-import             |
| `powersync.Dockerfile` | `journeyapps/powersync-service:latest`                   | PowerSync with sync rules config                       |
| `marketing.Dockerfile` | `oven/bun:latest` → `nginxinc/nginx-unprivileged:alpine` | Astro site (marketing, blog, docs), served by nginx    |

## Building

All Dockerfiles use the **repo root** as build context:

```bash
# From repo root:
docker build -f deploy/docker/backend.Dockerfile -t thunderbolt-backend .
docker build -f deploy/docker/frontend.Dockerfile -t thunderbolt-frontend .
docker build -f deploy/docker/postgres.Dockerfile -t thunderbolt-postgres .
docker build -f deploy/docker/keycloak.Dockerfile -t thunderbolt-keycloak .
docker build -f deploy/docker/powersync.Dockerfile -t thunderbolt-powersync .
docker build -f deploy/docker/marketing.Dockerfile -t thunderbolt-marketing .
```

## Frontend Build Args

The frontend Dockerfile accepts build args baked into the static bundle:

| Arg                          | Default | Purpose                                                 |
| ---------------------------- | ------- | ------------------------------------------------------- |
| `VITE_THUNDERBOLT_CLOUD_URL` | `/v1`   | Backend API URL (relative, proxied by nginx or ALB)     |
| `VITE_AUTH_MODE`             | `sso`   | Auth mode (`sso` for enterprise SSO, omit for consumer) |

## Backend Entrypoint

`backend-entrypoint.sh` runs Drizzle migrations before starting the server:

1. `bun drizzle-kit migrate` — applies pending migrations to Postgres
2. `bun run src/index.ts` — starts the Elysia server

The backend runs **interpreted** (not compiled) because Pino's worker thread transport is incompatible with `bun build --compile`.

## Files

```
docker/
  backend.Dockerfile
  backend-entrypoint.sh
  frontend.Dockerfile
  postgres.Dockerfile
  keycloak.Dockerfile
  powersync.Dockerfile
  marketing.Dockerfile
  postgres-init/
    01-powersync.sh       # Creates replication role, publication, and powersync_storage DB for PowerSync
```
